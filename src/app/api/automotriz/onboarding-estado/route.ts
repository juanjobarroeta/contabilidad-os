import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/automotriz/onboarding-estado?companyId=…
//
// Estado de la CARGA INICIAL de una agencia: qué etapas del pipeline ya
// corrieron y qué se derivó. Todo pasa solo (crons), pero el distribuidor
// necesita ver el avance en vez de preguntarse si el sistema está trabajando.
//
// Etapas, en el orden en que se alimentan:
//   1. CFDIs        — el sync del SAT trae el archivo (hasta 5 años).
//   2. XML          — sat-rawxml-backfill: sin XML no hay derivación.
//   3. Cancelaciones— sat-vigencia-sync: verifica vigencia por UUID.
//   4. Inventario   — vehiculos-backfill: unidades, costos, expediente.
//   5. Refacciones  — refacciones-backfill: catálogo + kardex (cursor durable).
//   6. Servicio     — servicio-backfill: historia del taller (cursor durable).
// ─────────────────────────────────────────────────────────────────────────────

const pct = (parte: number, total: number) => (total > 0 ? Math.round((parte / total) * 100) : null);

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const [
    cfdis,
    conXml,
    verificados,
    cancelados,
    unidades,
    refacciones,
    movimientos,
    servicios,
    progreso,
    primerCfdi,
  ] = await Promise.all([
    prisma.invoice.count({ where: { companyId } }),
    prisma.invoice.count({ where: { companyId, rawXml: { not: null } } }),
    prisma.invoice.count({ where: { companyId, vigenciaCheckedAt: { not: null } } }),
    prisma.invoice.count({ where: { companyId, status: "CANCELLED" } }),
    prisma.vehiculo.count({ where: { companyId } }),
    prisma.refaccion.count({ where: { companyId } }),
    prisma.refaccionMovimiento.count({ where: { refaccion: { companyId } } }),
    prisma.servicioVenta.count({ where: { companyId } }),
    prisma.backfillProgreso.findMany({
      where: { companyId },
      select: { job: true, cursor: true, procesados: true, derivados: true, completadoAt: true, updatedAt: true },
    }),
    prisma.invoice.findFirst({
      where: { companyId },
      orderBy: { fecha: "asc" },
      select: { fecha: true },
    }),
  ]);

  const porJob = Object.fromEntries(progreso.map((p) => [p.job, p]));

  return NextResponse.json({
    cobertura: {
      cfdis,
      desde: primerCfdi?.fecha ?? null,
      conXml,
      xmlPct: pct(conXml, cfdis),
    },
    etapas: [
      {
        clave: "xml",
        nombre: "Descarga de XML",
        detalle: `${conXml.toLocaleString("es-MX")} de ${cfdis.toLocaleString("es-MX")} CFDIs con XML`,
        avance: pct(conXml, cfdis),
        completa: cfdis > 0 && conXml >= cfdis,
      },
      {
        clave: "cancelaciones",
        nombre: "Verificación de cancelaciones",
        detalle: `${verificados.toLocaleString("es-MX")} verificados · ${cancelados.toLocaleString("es-MX")} cancelados`,
        avance: pct(verificados, cfdis),
        completa: cfdis > 0 && verificados >= cfdis,
      },
      {
        clave: "inventario",
        nombre: "Inventario de unidades",
        detalle: `${unidades.toLocaleString("es-MX")} unidades derivadas`,
        avance: null, // converge por cola, no por barrido
        completa: unidades > 0,
      },
      {
        clave: "refacciones",
        nombre: "Catálogo y kardex de refacciones",
        detalle: `${refacciones.toLocaleString("es-MX")} partes · ${movimientos.toLocaleString("es-MX")} movimientos`,
        avance: porJob.refacciones?.completadoAt ? 100 : null,
        completa: porJob.refacciones?.completadoAt != null,
        procesados: porJob.refacciones?.procesados ?? 0,
        ultimoAvance: porJob.refacciones?.updatedAt ?? null,
      },
      {
        clave: "servicio",
        nombre: "Historia del taller",
        detalle: `${servicios.toLocaleString("es-MX")} órdenes facturadas derivadas`,
        avance: porJob.servicio?.completadoAt ? 100 : null,
        completa: porJob.servicio?.completadoAt != null,
        procesados: porJob.servicio?.procesados ?? 0,
        ultimoAvance: porJob.servicio?.updatedAt ?? null,
      },
    ],
  });
});
