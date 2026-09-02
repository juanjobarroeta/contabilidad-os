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
    select: { rfc: true, regimenFiscal: true, codigoPostal: true },
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

  // La CSF es el registro del SAT: refresca los datos fiscales de la empresa.
  // regimenFiscal guarda UN código — los consumidores (impuestos, balance,
  // facturación) lo tratan como escalar; con varios regímenes en la constancia
  // se toma el principal (el primero). Las obligaciones de TODOS los regímenes
  // ya se upsertaron arriba. Antes se escribía "605,612" ahí, y eso rompía a
  // todo consumidor escalar del campo.
  const cambios: string[] = [];
  if (csf.regimenFiscal && csf.regimenFiscal !== company.regimenFiscal) {
    await prisma.company.update({
      where: { id: companyId },
      data: { regimenFiscal: csf.regimenFiscal },
    });
    cambios.push(`régimen ${company.regimenFiscal} → ${csf.regimenFiscal}`);
  }
  if (csf.codigoPostal && /^\d{5}$/.test(csf.codigoPostal) && csf.codigoPostal !== company.codigoPostal) {
    await prisma.company.update({
      where: { id: companyId },
      data: { codigoPostal: csf.codigoPostal },
    });
    cambios.push(`CP ${company.codigoPostal || "—"} → ${csf.codigoPostal}`);
  }

  return NextResponse.json({
    ok: true,
    rfc: csf.rfc,
    razonSocial: csf.razonSocial,
    regimenes: csf.regimenes,
    obligacionesActualizadas: results.obligaciones,
    created: results.created,
    updated: results.updated,
    cambios,
    message: [
      results.obligaciones.length === 1
        ? "1 obligación actualizada"
        : `${results.obligaciones.length} obligaciones actualizadas`,
      csf.regimenes.length === 1 ? "1 régimen en la constancia" : `${csf.regimenes.length} regímenes en la constancia`,
      ...cambios,
    ].join(" · "),
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
