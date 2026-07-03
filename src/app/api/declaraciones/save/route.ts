import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";

// POST /api/declaraciones/save
//
// Guarda un acuse de declaración capturado desde su PDF: persiste los campos
// parseados (por /api/onboarding/parse-document) en un TaxDeclaration y conserva
// el PDF completo (bytea, por ahora; TODO migrar a Cloudflare R2 — ver HANDOFF).
// Reemplaza la captura manual de línea de captura / monto: subes el PDF y listo.
//
// Idempotente por (companyId, tipo, periodo): re-subir reemplaza.

type TipoDecl = "DECLARACION_ANUAL" | "IVA_MENSUAL" | "ISR_PROVISIONAL";

interface AcuseParsed {
  // mensual
  ivaCausado?: number | null;
  ivaAcreditable?: number | null;
  ivaAPagar?: number | null;
  ivaAFavor?: number | null;
  isrIngresos?: number | null;
  isrAPagar?: number | null;
  coeficienteUtilidadAplicado?: number | null;
  // anual
  ejercicio?: number | null;
  coeficienteUtilidad?: number | null;
  utilidadFiscal?: number | null;
  isrAFavor?: number | null;
  // común
  lineaCaptura?: string | null;
  fechaPresentacion?: string | null;
}

const MAX_PDF_BYTES = 6 * 1024 * 1024; // 6 MB — un acuse del SAT pesa <300 KB

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    companyId?: string;
    tipo?: TipoDecl;
    periodo?: string;
    pdfBase64?: string;
    filename?: string;
    acuse?: AcuseParsed;
  } | null;

  if (!body?.companyId || !body.tipo || !body.periodo) {
    return NextResponse.json({ error: "Faltan companyId, tipo o periodo" }, { status: 400 });
  }
  const { companyId, tipo, periodo } = body;
  if (!["DECLARACION_ANUAL", "IVA_MENSUAL", "ISR_PROVISIONAL"].includes(tipo)) {
    return NextResponse.json({ error: "tipo inválido" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  // Gating de suscripción (bandera SUBSCRIPTION_ENFORCEMENT_ENABLED).
  const gate = await gateEscritura(session.user.id);
  if (gate) return gate;

  const a = body.acuse ?? {};
  const fecha = a.fechaPresentacion ? new Date(a.fechaPresentacion) : null;
  const fechaPresentacion = fecha && !isNaN(fecha.getTime()) ? fecha : null;

  // PDF → bytea (opcional, pero es el punto: conservar el original).
  let acusePdf: Buffer | undefined;
  if (body.pdfBase64) {
    const buf = Buffer.from(body.pdfBase64, "base64");
    if (buf.length > MAX_PDF_BYTES) {
      return NextResponse.json({ error: "El PDF excede 6 MB" }, { status: 413 });
    }
    acusePdf = buf;
  }

  // Mapea los campos parseados al renglón según el tipo.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: Record<string, any> = {
    companyId,
    tipo,
    periodo,
    status: "FILED",
    isHistorical: true, // capturado de un acuse, no calculado por el motor
    lineaCaptura: a.lineaCaptura ?? null,
    fechaPresentacion,
    acusePdfNombre: body.filename ?? null,
    ...(acusePdf !== undefined ? { acusePdf } : {}),
  };

  if (tipo === "IVA_MENSUAL") {
    data.ivaTrasladadoCobrado = a.ivaCausado ?? null;
    data.ivaAcreditableGastado = a.ivaAcreditable ?? null;
    data.ivaPagar = a.ivaAPagar ?? null;
    data.ivaSaldoFavor = a.ivaAFavor ?? null;
  } else if (tipo === "ISR_PROVISIONAL") {
    data.isrIngresos = a.isrIngresos ?? null;
    data.isrPagar = a.isrAPagar ?? null;
    data.isrCoeficienteUtilidad = a.coeficienteUtilidadAplicado ?? null;
  } else {
    // DECLARACION_ANUAL
    data.isrIngresos = a.utilidadFiscal ?? null;
    data.isrPagar = a.isrAPagar ?? null;
    data.isrCoeficienteUtilidad = a.coeficienteUtilidad ?? null;
    data.isrSaldoFavor = a.isrAFavor ?? null;
  }

  // Upsert manual por (companyId, tipo, periodo) — no hay unique compuesto.
  const existing = await prisma.taxDeclaration.findFirst({
    where: { companyId, tipo, periodo },
    select: { id: true },
  });
  const saved = existing
    ? await prisma.taxDeclaration.update({ where: { id: existing.id }, data })
    : await prisma.taxDeclaration.create({ data: data as Prisma.TaxDeclarationUncheckedCreateInput });

  // La anual fija el coeficiente de utilidad del ejercicio siguiente.
  if (tipo === "DECLARACION_ANUAL" && a.coeficienteUtilidad != null) {
    await prisma.company.update({
      where: { id: companyId },
      data: { coeficienteUtilidad: a.coeficienteUtilidad },
    });
  }

  return NextResponse.json({ ok: true, id: saved.id });
}
