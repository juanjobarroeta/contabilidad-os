import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOperador } from "@/lib/authz";
import { backfillDeclaracionesMensuales } from "@/lib/fiscal/cumplimiento/syntage/declaraciones-backfill";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/operador/declaraciones-backfill   { companyId|rfc, year?, maxAcuses? }
//
// Operator-only, on-demand. Ingests a company's prior FILED monthly declaraciones
// from Syntage (downloads each acuse PDF, parses the IVA/ISR desglose via Claude,
// and stores IVA_MENSUAL + ISR_PROVISIONAL rows). That populates the CARRYOVER
// CHAIN the motor reads — `ISR pagado anterior` (sum of prior isrPagar) and the
// IVA `saldo a favor` — so the monthly calc matches what the accountant filed.
//
// Same engine + gap-fill as the monthly cron, but triggerable per company from
// the app (the cron is CRON_SECRET-gated). Costs ~1 Claude call per missing
// month, so it's operator-gated. If Syntage lacks a company's prior acuses,
// nothing is created — fall back to uploading the acuse in Impuestos/cierre.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isOperador(session.user.id))) {
    return NextResponse.json({ error: "Sólo disponible para operador de plataforma" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const company = body?.companyId
    ? await prisma.company.findUnique({ where: { id: String(body.companyId) }, select: { id: true, rfc: true, razonSocial: true } })
    : body?.rfc
      ? await prisma.company.findFirst({ where: { rfc: { equals: String(body.rfc).trim(), mode: "insensitive" } }, select: { id: true, rfc: true, razonSocial: true } })
      : null;
  if (!company) return NextResponse.json({ error: "Empresa no encontrada (usa companyId o rfc)" }, { status: 404 });

  // Bound the Claude cost per call. One company's missing months is small.
  const maxAcuses = Math.min(Math.max(parseInt(String(body?.maxAcuses ?? "24"), 10) || 24, 1), 60);

  const result = await backfillDeclaracionesMensuales(company.id, undefined, { maxAcuses });

  // Show the resulting chain so the operator can confirm prior months filled.
  const year = Number.isInteger(body?.year) ? (body.year as number) : new Date().getFullYear();
  const decls = await prisma.taxDeclaration.findMany({
    where: {
      companyId: company.id,
      tipo: { in: ["ISR_PROVISIONAL", "IVA_MENSUAL"] },
      periodo: { startsWith: `${year}-` },
      status: { in: ["CALCULATED", "FILED", "PAID"] },
    },
    select: { tipo: true, periodo: true, isrPagar: true, ivaPagar: true, ivaSaldoFavor: true, status: true },
    orderBy: { periodo: "asc" },
  });

  const isr = decls.filter((d) => d.tipo === "ISR_PROVISIONAL");
  const iva = decls.filter((d) => d.tipo === "IVA_MENSUAL");

  return NextResponse.json({
    ok: true,
    company: { id: company.id, rfc: company.rfc, razonSocial: company.razonSocial },
    backfill: {
      mesesCreados: result.mesesCreados,
      acusesParseados: result.acusesParseados,
      topeAlcanzado: result.topeAlcanzado ?? false,
      error: result.error ?? null,
    },
    // Resulting carryover chain for the year — what the motor will now read.
    cadena: {
      year,
      isrProvisional: isr.map((d) => ({ periodo: d.periodo, isrPagar: d.isrPagar, status: d.status })),
      ivaMensual: iva.map((d) => ({ periodo: d.periodo, ivaPagar: d.ivaPagar, ivaSaldoFavor: d.ivaSaldoFavor, status: d.status })),
    },
    nota: result.error
      ? "Syntage no devolvió datos para esta empresa — captura los acuses manualmente en Impuestos/cierre."
      : result.mesesCreados === 0
        ? "No se creó ningún mes nuevo (ya capturados, o Syntage no tiene esos acuses). Si faltan, súbelos en Impuestos/cierre."
        : "Meses ingresados. Vuelve a calcular el periodo: ISR pagado anterior y saldo a favor ya deberían reflejar lo presentado.",
  });
}
