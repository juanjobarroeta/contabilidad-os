import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parsearTextoCsf, mapCsfObligacion, REGIMEN_MAP } from "@/lib/obligaciones";
import { getEffectiveCompanyMembership } from "@/lib/authz";

// POST /api/obligaciones/csf
// Body: { companyId, csfBase64 }
// Parses a SAT Constancia de Situación Fiscal PDF and upserts obligations.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, csfBase64 } = body;

  if (!companyId || !csfBase64) {
    return NextResponse.json({ error: "companyId y csfBase64 son requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  // Decode base64 → Buffer
  const pdfBuffer = Buffer.from(csfBase64, "base64");

  // Parse PDF text
  let text: string;
  try {
    // pdf-parse is CommonJS — use require to avoid ESM issues
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(pdfBuffer);
    text = data.text;
  } catch (err) {
    console.error("[csf/parse] pdf-parse error:", err);
    return NextResponse.json({ error: "No se pudo leer el PDF. Verifica que sea un CSF válido del SAT." }, { status: 422 });
  }

  // Extract data from CSF text
  const csf = parsearTextoCsf(text);

  if (!csf.rfc && csf.regimenes.length === 0) {
    return NextResponse.json({ error: "No se encontró información fiscal en el PDF. ¿Es una CSF del SAT?" }, { status: 422 });
  }

  // Verify RFC matches company
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, regimenFiscal: true },
  });
  if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  if (csf.rfc && csf.rfc.toUpperCase() !== company.rfc.toUpperCase()) {
    return NextResponse.json({
      error: `El RFC en la CSF (${csf.rfc}) no coincide con el RFC de la empresa (${company.rfc}).`,
    }, { status: 422 });
  }

  const results = { updated: 0, created: 0, regimenes: csf.regimenes, obligaciones: [] as string[] };

  // Upsert regime-based obligations from CSF regimenes
  for (const reg of csf.regimenes) {
    const regObligaciones = REGIMEN_MAP[reg.codigo]?.obligaciones ?? [];
    for (const ob of regObligaciones) {
      const parsedDesde = reg.desde ? parseDate(reg.desde) : null;
      const existing = await prisma.companyObligation.findUnique({
        where: { companyId_tipo: { companyId, tipo: ob.tipo } },
      });
      if (existing) {
        await prisma.companyObligation.update({
          where: { companyId_tipo: { companyId, tipo: ob.tipo } },
          data: {
            descripcion: ob.descripcion,
            periodicidad: ob.periodicidad,
            diaVencimiento: ob.diaVencimiento,
            mesVencimiento: ob.mesVencimiento ?? null,
            fuente: "CSF",
            activa: true,
            desdeAnio: parsedDesde?.year ?? null,
            desdeMes: parsedDesde?.month ?? null,
          },
        });
        results.updated++;
      } else {
        await prisma.companyObligation.create({
          data: {
            companyId, tipo: ob.tipo,
            descripcion: ob.descripcion,
            periodicidad: ob.periodicidad,
            diaVencimiento: ob.diaVencimiento,
            mesVencimiento: ob.mesVencimiento ?? null,
            fuente: "CSF",
            desdeAnio: parsedDesde?.year ?? null,
            desdeMes: parsedDesde?.month ?? null,
          },
        });
        results.created++;
      }
      results.obligaciones.push(ob.tipo);
    }
  }

  // Also process any obligations explicitly listed in the CSF text
  for (const ob of csf.obligaciones) {
    const tipo = mapCsfObligacion(ob.descripcion);
    if (!tipo || results.obligaciones.includes(tipo)) continue;

    const periodicidad = normalizePeriodicidad(ob.periodicidad);
    const diaVencimiento = 17;
    const parsedDesde = ob.desde ? parseDate(ob.desde) : null;

    await prisma.companyObligation.upsert({
      where: { companyId_tipo: { companyId, tipo } },
      update: { fuente: "CSF", activa: true, periodicidad, desdeAnio: parsedDesde?.year ?? null, desdeMes: parsedDesde?.month ?? null },
      create: { companyId, tipo, descripcion: ob.descripcion, periodicidad, diaVencimiento, fuente: "CSF", desdeAnio: parsedDesde?.year ?? null, desdeMes: parsedDesde?.month ?? null },
    });
    results.obligaciones.push(tipo);
    results.created++;
  }

  // Update company regimenFiscal if CSF found a regime and current is different
  if (csf.regimenFiscal && csf.regimenFiscal !== company.regimenFiscal) {
    const allCodes = csf.regimenes.map(r => r.codigo).join(",");
    await prisma.company.update({
      where: { id: companyId },
      data: { regimenFiscal: allCodes },
    });
  }

  return NextResponse.json({
    ok: true,
    rfc: csf.rfc,
    razonSocial: csf.razonSocial,
    regimenes: csf.regimenes,
    obligacionesActualizadas: results.obligaciones,
    created: results.created,
    updated: results.updated,
    message: `CSF procesada: ${results.obligaciones.length} obligacion(es) actualizadas desde ${csf.regimenes.length} régimen(es).`,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseDate(str: string): { year: number; month: number } | null {
  // Expects "DD/MM/YYYY"
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return { year: parseInt(m[3]), month: parseInt(m[2]) };
}

function normalizePeriodicidad(raw: string): "MENSUAL" | "BIMESTRAL" | "ANUAL" {
  const r = raw.toLowerCase();
  if (r.includes("bimestral")) return "BIMESTRAL";
  if (r.includes("anual"))     return "ANUAL";
  return "MENSUAL";
}
