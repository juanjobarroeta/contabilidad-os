import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import { estadoPagosImss, periodoImssMensual, bimestreDe } from "@/lib/fiscal/imss-pagos";
import type { TaxDeclarationType } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Ciclo de pago de cuotas IMSS (SIPARE).
//
// GET  /api/impuestos/imss?companyId&year&month → estadoPagosImss: estimado
//      mensual (cuotas obrero-patronales, día 17 del mes siguiente) y, cuando
//      el mes cierra bimestre, el estimado RCV + Infonavit bimestral.
// POST → registra/actualiza el pago como fila TaxDeclaration (IMSS_MENSUAL o
//      IMSS_BIMESTRAL): monto pagado (precargado con el estimado, editable),
//      línea de captura SIPARE, fecha de pago y estatus FILED/PAID. Espeja el
//      upsert por (companyId, tipo, periodo) de /api/impuestos.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const year = parseInt(searchParams.get("year") ?? "");
  const month = parseInt(searchParams.get("month") ?? "");

  if (!companyId || isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: "companyId, year y month son requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const estado = await estadoPagosImss(companyId, year, month);
  return NextResponse.json(estado);
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const {
    companyId,
    year,
    month,
    /** "MENSUAL" (cuotas del mes) o "BIMESTRAL" (RCV + Infonavit del bimestre). */
    ambito,
    monto,
    lineaCaptura,
    fechaPresentacion,
    status,
  } = body as {
    companyId?: string;
    year?: number;
    month?: number;
    ambito?: string;
    monto?: number;
    lineaCaptura?: string | null;
    fechaPresentacion?: string | null;
    status?: string;
  };

  if (!companyId || !year || !month || month < 1 || month > 12) {
    return NextResponse.json({ error: "companyId, year y month son requeridos" }, { status: 400 });
  }
  if (ambito !== "MENSUAL" && ambito !== "BIMESTRAL") {
    return NextResponse.json({ error: "ambito debe ser MENSUAL o BIMESTRAL" }, { status: 400 });
  }
  if (status !== undefined && status !== "FILED" && status !== "PAID") {
    return NextResponse.json({ error: "status debe ser FILED o PAID" }, { status: 400 });
  }
  const statusVal = status as "FILED" | "PAID" | undefined;
  if (monto !== undefined && (typeof monto !== "number" || !isFinite(monto) || monto < 0)) {
    return NextResponse.json({ error: "monto inválido" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  // El bimestral sólo se registra en el mes que CIERRA el bimestre; su periodo
  // se llavea con ese mes de cierre ("2026-02" = ene-feb).
  const bim = bimestreDe(year, month);
  if (ambito === "BIMESTRAL" && !bim.cierraBimestre) {
    return NextResponse.json(
      { error: "El pago bimestral se registra en el mes que cierra el bimestre (feb, abr, jun, ago, oct o dic)" },
      { status: 400 }
    );
  }

  const tipo: TaxDeclarationType = ambito === "MENSUAL" ? "IMSS_MENSUAL" : "IMSS_BIMESTRAL";
  const periodo = ambito === "MENSUAL" ? `${year}-${String(month).padStart(2, "0")}` : bim.periodo;
  const fechaLimite =
    ambito === "MENSUAL"
      ? periodoImssMensual(year, month, { imssObrero: 0, imssPatronal: 0 }).fechaLimite
      : bim.fechaLimite;

  // Patch parcial: cada campo se aplica sólo si el cliente lo mandó, para que
  // un guardado parcial nunca borre lo capturado antes (misma disciplina que
  // /api/impuestos).
  const patch = {
    ...(statusVal !== undefined && { status: statusVal }),
    ...(monto !== undefined && { imssCuotas: monto }),
    ...(lineaCaptura !== undefined && { lineaCaptura: lineaCaptura || null }),
    ...(fechaPresentacion !== undefined && {
      fechaPresentacion: fechaPresentacion ? new Date(fechaPresentacion) : null,
    }),
    fechaLimitePago: fechaLimite,
  };

  const existing = await prisma.taxDeclaration.findFirst({
    where: { companyId, tipo, periodo },
    select: { id: true },
  });
  const row = existing
    ? await prisma.taxDeclaration.update({ where: { id: existing.id }, data: patch })
    : await prisma.taxDeclaration.create({
        data: { companyId, tipo, periodo, status: "CALCULATED", ...patch },
      });

  registrarBitacora({
    companyId,
    userId: session.user.id,
    actorEmail: session.user.email ?? null,
    accion: "imss.pago.registrar",
    entidad: "TaxDeclaration",
    entidadId: row.id,
    detalle: {
      tipo,
      periodo,
      status: row.status,
      monto: row.imssCuotas,
      lineaCaptura: row.lineaCaptura,
    },
    req,
  });

  return NextResponse.json({
    id: row.id,
    tipo,
    periodo,
    status: row.status,
    monto: row.imssCuotas,
    lineaCaptura: row.lineaCaptura,
    fechaPresentacion: row.fechaPresentacion,
    fechaLimitePago: row.fechaLimitePago,
  });
}
