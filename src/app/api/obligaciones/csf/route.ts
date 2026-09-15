import { NextResponse } from "next/server";
import { textoDePdf } from "@/lib/fiscal/fuentes/texto";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parsearTextoCsf, mapCsfObligacion, REGIMEN_MAP } from "@/lib/obligaciones";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import {
  CompanyRegimenSyncError,
  planCompanyRegimenSync,
  type CompanyRegimenSyncPlan,
} from "@/lib/fiscal/company-regimen-sync";

// POST /api/obligaciones/csf
// Body: { companyId, csfBase64, regimenFiscalPrincipal? }
// Parses a SAT Constancia de Situación Fiscal PDF and upserts obligations.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, csfBase64, regimenFiscalPrincipal } = body;

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
    // pdf-parse v2: `new PDFParse({data}).getText()` — el módulo ya no exporta
    // una función; llamarlo tiraba «pdfParse is not a function» y toda CSF
    // subida salía como «No se pudo leer el PDF».
    text = await textoDePdf(pdfBuffer);
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
    select: {
      rfc: true,
      regimenFiscal: true,
      codigoPostal: true,
      regimenes: {
        select: {
          code: true,
          label: true,
          since: true,
          isPrimary: true,
          active: true,
        },
      },
    },
  });
  if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  if (csf.rfc && csf.rfc.toUpperCase() !== company.rfc.toUpperCase()) {
    return NextResponse.json({
      error: `El RFC en la CSF (${csf.rfc}) no coincide con el RFC de la empresa (${company.rfc}).`,
    }, { status: 422 });
  }

  // Validate the complete replacement plan before writing obligations or
  // company data. With multiple regimes, the first PDF row is not treated as a
  // primary: preserve the current primary when it is still active, or require
  // an explicit regimenFiscalPrincipal from the user.
  let regimenPlan: CompanyRegimenSyncPlan;
  try {
    regimenPlan = planCompanyRegimenSync({
      companyPrimary: company.regimenFiscal,
      parsedPrimary: typeof regimenFiscalPrincipal === "string"
        ? regimenFiscalPrincipal
        : csf.regimenFiscal,
      parsedRegimenes: csf.regimenes.map((regimen) => ({
        code: regimen.codigo,
        label: regimen.nombre,
        since: regimen.desde,
      })),
      existingRegimenes: company.regimenes,
    });
  } catch (error) {
    if (error instanceof CompanyRegimenSyncError) {
      return NextResponse.json({
        code: error.code,
        error: error.message,
        regimenes: csf.regimenes,
      }, { status: 422 });
    }
    throw error;
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

  // La CSF es el registro del SAT: refresca el conjunto vigente sin borrar su
  // historia. Company.regimenFiscal remains the explicitly selected primary;
  // CompanyRegimen carries the current state and latest end date of each regime.
  const cambios: string[] = [];
  if (regimenPlan.primaryCode !== company.regimenFiscal) {
    cambios.push(`régimen principal ${company.regimenFiscal} → ${regimenPlan.primaryCode}`);
  }
  if (regimenPlan.activatedCodes.length > 0) {
    cambios.push(`regímenes activados: ${regimenPlan.activatedCodes.join(", ")}`);
  }
  if (regimenPlan.deactivatedCodes.length > 0) {
    cambios.push(`regímenes terminados: ${regimenPlan.deactivatedCodes.join(", ")}`);
  }
  const codigoPostalCsf = csf.codigoPostal && /^\d{5}$/.test(csf.codigoPostal)
    ? csf.codigoPostal
    : null;
  if (codigoPostalCsf && codigoPostalCsf !== company.codigoPostal) {
    cambios.push(`CP ${company.codigoPostal || "—"} → ${csf.codigoPostal}`);
  }

  const endedAt = new Date();
  await prisma.$transaction(async (tx) => {
    // Clear every old marker first so exactly one active row mirrors the scalar.
    await tx.companyRegimen.updateMany({
      where: { companyId },
      data: { isPrimary: false },
    });
    if (regimenPlan.deactivatedCodes.length > 0) {
      await tx.companyRegimen.updateMany({
        where: { companyId, code: { in: regimenPlan.deactivatedCodes }, active: true },
        data: { active: false, endedAt },
      });
    }
    for (const regimen of regimenPlan.upserts) {
      await tx.companyRegimen.upsert({
        where: { companyId_code: { companyId, code: regimen.code } },
        update: {
          label: regimen.label,
          since: regimen.since,
          isPrimary: regimen.isPrimary,
          active: true,
          endedAt: null,
        },
        create: {
          companyId,
          code: regimen.code,
          label: regimen.label,
          since: regimen.since,
          isPrimary: regimen.isPrimary,
          active: true,
        },
      });
    }
    await tx.company.update({
      where: { id: companyId },
      data: {
        regimenFiscal: regimenPlan.primaryCode,
        ...(codigoPostalCsf ? { codigoPostal: codigoPostalCsf } : {}),
      },
    });
  });

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
