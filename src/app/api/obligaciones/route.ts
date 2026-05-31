import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { calcularVencimiento, ObligacionConfig } from "@/lib/obligaciones";
import { seedCompanyObligaciones } from "@/lib/obligaciones-seed";

// ── GET /api/obligaciones?companyId=xxx&year=2026 ─────────────────────────────
// Returns the obligation calendar for the year, with filing status for each period.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const year = parseInt(searchParams.get("year") ?? String(new Date().getFullYear()));

  if (!companyId || isNaN(year)) {
    return NextResponse.json({ error: "companyId y year son requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { regimenFiscal: true, regimenes: { select: { code: true } } },
  });
  if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  // Ensure obligations are seeded for this company (idempotent). Prefer the full
  // CompanyRegimen list; fall back to the comma-separated primary for legacy rows.
  const regimenCodes =
    company.regimenes.length > 0
      ? company.regimenes.map((r) => r.code)
      : company.regimenFiscal
      ? company.regimenFiscal.split(",").map((c) => c.trim()).filter(Boolean)
      : [];
  await seedCompanyObligaciones(companyId, regimenCodes);

  // Load obligations from DB (includes any CSF overrides)
  const dbObligaciones = await prisma.companyObligation.findMany({
    where: { companyId, activa: true },
    orderBy: { tipo: "asc" },
  });

  // Load all declarations for this year
  const declarations = await prisma.taxDeclaration.findMany({
    where: {
      companyId,
      periodo: { startsWith: String(year) },
    },
    select: { tipo: true, periodo: true, status: true, isHistorical: true },
  });
  const declMap = new Map(declarations.map(d => [`${d.tipo}::${d.periodo}`, d.status]));

  // Find company creation date — periods before this shouldn't be OVERDUE
  const companyRecord = await prisma.company.findUnique({
    where: { id: companyId },
    select: { createdAt: true },
  });
  const companyCreatedAt = companyRecord?.createdAt ?? new Date();

  const now = new Date();

  // Build calendar per obligation
  const calendar = dbObligaciones.map(ob => {
    const obConfig: ObligacionConfig = {
      tipo: ob.tipo,
      descripcion: ob.descripcion,
      periodicidad: ob.periodicidad as "MENSUAL" | "BIMESTRAL" | "ANUAL",
      diaVencimiento: ob.diaVencimiento,
      mesVencimiento: ob.mesVencimiento ?? undefined,
    };

    const periodos = buildPeriodos(obConfig, year);

    return {
      tipo: ob.tipo,
      descripcion: ob.descripcion,
      periodicidad: ob.periodicidad,
      fuente: ob.fuente,
      periodos: periodos.map(periodo => {
        const vencimiento = calcularVencimiento(obConfig, periodo);
        // Map our TaxDeclarationType to obligation tipo
        const declTipo = mapObligacionToDeclType(ob.tipo);
        const declStatus = declTipo ? declMap.get(`${declTipo}::${periodo}`) : undefined;

        let estado: "FILED" | "PENDING" | "OVERDUE" | "UPCOMING" | "NOT_APPLICABLE";
        if (declStatus === "FILED" || declStatus === "PAID") {
          estado = "FILED";
        } else if (declStatus === "CALCULATED") {
          estado = "PENDING";
        } else if (vencimiento < companyCreatedAt) {
          // Period ended before the company was onboarded — don't show as overdue
          estado = "NOT_APPLICABLE";
        } else if (vencimiento < now) {
          estado = "OVERDUE";
        } else if (vencimiento.getTime() - now.getTime() < 30 * 24 * 60 * 60 * 1000) {
          estado = "UPCOMING";
        } else {
          estado = "PENDING";
        }

        return {
          periodo,
          label: periodoLabel(periodo, ob.periodicidad),
          vencimiento: vencimiento.toISOString(),
          estado,
          declaracionStatus: declStatus ?? null,
        };
      }),
    };
  });

  return NextResponse.json({ year, obligaciones: calendar });
}

// ── POST /api/obligaciones — seed or resync obligations from régimen ──────────
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, action } = body;

  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  if (action === "resync") {
    // Delete REGIMEN-sourced obligations and re-seed from the full régimen set.
    await prisma.companyObligation.deleteMany({ where: { companyId, fuente: "REGIMEN" } });
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { regimenFiscal: true, regimenes: { select: { code: true } } },
    });
    if (company) {
      const codes =
        company.regimenes.length > 0
          ? company.regimenes.map((r) => r.code)
          : company.regimenFiscal
          ? company.regimenFiscal.split(",").map((c) => c.trim()).filter(Boolean)
          : [];
      await seedCompanyObligaciones(companyId, codes, { force: true });
    }
  }

  const updated = await prisma.companyObligation.findMany({
    where: { companyId, activa: true },
  });
  return NextResponse.json({ ok: true, count: updated.length });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPeriodos(ob: ObligacionConfig, year: number): string[] {
  if (ob.periodicidad === "ANUAL") return [String(year)];
  if (ob.periodicidad === "BIMESTRAL") {
    return ["B1", "B2", "B3", "B4", "B5", "B6"].map(b => `${year}-${b}`);
  }
  // MENSUAL
  return Array.from({ length: 12 }, (_, i) =>
    `${year}-${String(i + 1).padStart(2, "0")}`
  );
}

function periodoLabel(periodo: string, periodicidad: string): string {
  const MONTHS = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
  if (periodicidad === "ANUAL") return `Ejercicio ${periodo}`;
  if (periodicidad === "BIMESTRAL") {
    const b = parseInt(periodo.split("-B")[1]);
    const m1 = MONTHS[(b - 1) * 2];
    const m2 = MONTHS[(b - 1) * 2 + 1];
    return `${m1}–${m2}`;
  }
  const [y, m] = periodo.split("-");
  return `${MONTHS[parseInt(m) - 1]} ${y}`;
}

function mapObligacionToDeclType(tipo: string): string | null {
  const map: Record<string, string> = {
    "IVA_MENSUAL":     "IVA_MENSUAL",
    "ISR_PROVISIONAL": "IVA_MENSUAL",  // we store both in IVA_MENSUAL declarations for now
    "DIOT":            "IVA_MENSUAL",
    "ISR_ANUAL":       "DECLARACION_ANUAL",
    "ISR_BIMESTRAL":   "IVA_MENSUAL",
    "IVA_BIMESTRAL":   "IVA_MENSUAL",
  };
  return map[tipo] ?? null;
}
