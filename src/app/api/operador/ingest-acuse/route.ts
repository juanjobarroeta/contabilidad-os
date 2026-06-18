import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOperador } from "@/lib/authz";
import { parseSatDocument } from "@/lib/fiscal/acuse/parse";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST /api/operador/ingest-acuse   { companyId, pdfBase64 }
//
// Operator-only. Manual equivalent of the Syntage declaraciones backfill, for
// companies Syntage doesn't have history for: parse an uploaded acuse PDF with
// Claude and store the FILED figures (isrPagar, ivaSaldoFavor, …) as
// IVA_MENSUAL / ISR_PROVISIONAL rows — the carryover chain the motor reads.
//
// The period comes from the acuse itself. Gap-fill: never overwrites an existing
// row for that periodo/tipo. Faithful to what was filed (unlike the cierre upload,
// which stores the system's recomputed figures).
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isOperador(session.user.id))) {
    return NextResponse.json({ error: "Sólo disponible para operador de plataforma" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const companyId = body?.companyId;
  const pdfBase64 = body?.pdfBase64;
  if (typeof companyId !== "string" || !companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  if (typeof pdfBase64 !== "string" || !pdfBase64) {
    return NextResponse.json({ error: "pdfBase64 requerido" }, { status: 400 });
  }

  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, rfc: true, razonSocial: true } });
  if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  let parsed;
  try {
    parsed = await parseSatDocument(pdfBase64, { companyId, subtipo: "operador.ingest-acuse" });
  } catch (e) {
    return NextResponse.json({ error: `No se pudo leer el PDF: ${e instanceof Error ? e.message : "error"}` }, { status: 422 });
  }
  if (parsed.type !== "ACUSE_MENSUAL" || !parsed.acuseMensual) {
    return NextResponse.json(
      { error: `El documento se detectó como "${parsed.type}". Sube un acuse de declaración mensual (PDF).` },
      { status: 422 }
    );
  }

  const acuse = parsed.acuseMensual;
  const anio = acuse.periodoAnio ?? (acuse.fechaPresentacion ? new Date(acuse.fechaPresentacion).getFullYear() : null);
  const mes = acuse.periodoMes ?? null;
  if (!anio || !mes || mes < 1 || mes > 12) {
    return NextResponse.json({ error: "No se pudo determinar el periodo del acuse." }, { status: 422 });
  }
  const periodo = `${anio}-${String(mes).padStart(2, "0")}`;

  const fecha = acuse.fechaPresentacion ? new Date(acuse.fechaPresentacion) : null;
  const acusePdfNombre = `acuse-${periodo}.pdf`;
  const pdf = new Uint8Array(Buffer.from(pdfBase64, "base64"));

  const existing = await prisma.taxDeclaration.findMany({
    where: { companyId, periodo, tipo: { in: ["IVA_MENSUAL", "ISR_PROVISIONAL"] } },
    select: { tipo: true },
  });
  const have = new Set(existing.map((d) => d.tipo));

  const tieneDatosIva = acuse.ivaAPagar != null || acuse.ivaCausado != null || acuse.ivaAFavor != null || acuse.ivaAcreditable != null;
  const tieneDatosIsr = acuse.isrAPagar != null || acuse.isrIngresos != null;

  const creados: string[] = [];
  if (tieneDatosIva && !have.has("IVA_MENSUAL")) {
    await prisma.taxDeclaration.create({
      data: {
        companyId, tipo: "IVA_MENSUAL", periodo, status: "FILED", isHistorical: true,
        ivaTrasladadoCobrado: acuse.ivaCausado, ivaAcreditableGastado: acuse.ivaAcreditable,
        ivaPagar: acuse.ivaAPagar, ivaSaldoFavor: acuse.ivaAFavor,
        lineaCaptura: acuse.lineaCaptura ?? null, fechaPresentacion: fecha,
        acusePdf: pdf, acusePdfNombre,
      },
    });
    creados.push("IVA_MENSUAL");
  }
  if (tieneDatosIsr && !have.has("ISR_PROVISIONAL")) {
    await prisma.taxDeclaration.create({
      data: {
        companyId, tipo: "ISR_PROVISIONAL", periodo, status: "FILED", isHistorical: true,
        isrIngresos: acuse.isrIngresos, isrPagar: acuse.isrAPagar,
        isrCoeficienteUtilidad: acuse.coeficienteUtilidadAplicado,
        lineaCaptura: acuse.lineaCaptura ?? null, fechaPresentacion: fecha,
        acusePdf: pdf, acusePdfNombre,
      },
    });
    creados.push("ISR_PROVISIONAL");
  }

  return NextResponse.json({
    ok: true,
    company: { id: company.id, rfc: company.rfc, razonSocial: company.razonSocial },
    periodo,
    creados,
    yaExistian: [...have],
    parsed: {
      isrAPagar: acuse.isrAPagar, isrPagosAnteriores: acuse.isrPagosAnteriores, isrIngresos: acuse.isrIngresos,
      ivaAPagar: acuse.ivaAPagar, ivaAFavor: acuse.ivaAFavor, coeficiente: acuse.coeficienteUtilidadAplicado,
    },
    nota: creados.length === 0
      ? "Ese periodo ya estaba capturado (no se sobrescribe)."
      : `Capturado ${periodo}: ${creados.join(" + ")}. Vuelve a correr Cross-check.`,
  });
}
