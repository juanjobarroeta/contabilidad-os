// ─────────────────────────────────────────────────────────────────────────────
// Estado del alta de una empresa (pantalla Historial, chip/anillo, tarjeta de
// Hoy y avisos de hitos). Todo sale de la base; ver historial.ts para la
// interpretación. Sin autorización: el llamador ya la verificó.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { evaluarEtapas } from "./estado";
import {
  estimarTiempos,
  medianaRespuestaSat,
  mesesHistorial,
  MS_RESPUESTA_SAT_DEFAULT,
  resumirHistorial,
  type SolicitudMes,
} from "./historial";

/**
 * Lo que tarda el SAT en el portafolio (últimos 14 días), para empresas sin
 * historia propia todavía. null si no hay muestras.
 */
async function medianaPortafolio(): Promise<number | null> {
  const r = await prisma.$queryRaw<Array<{ ms: number | null; n: bigint }>>`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("updatedAt" - "createdAt")) * 1000) AS ms,
           COUNT(*) AS n
    FROM "SatSyncRequest"
    WHERE "status" = 'FINISHED'
      AND "tipo" IN ('EMITIDOS', 'RECIBIDOS')
      AND "createdAt" > now() - interval '14 days'
      AND "updatedAt" > "createdAt"
  `;
  const fila = r[0];
  return fila && Number(fila.n) >= 5 && fila.ms != null ? Number(fila.ms) : null;
}

export async function cargarEstadoAlta(companyId: string) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      rfc: true,
      razonSocial: true,
      satBackfillYears: true,
      fechaInicioOperaciones: true,
      satBackfillCompletedAt: true,
      fielCer: true,
    },
  });
  if (!company) return null;

  const hoy = new Date();
  const anios = Math.max(1, company.satBackfillYears);
  const anioMin = hoy.getUTCFullYear() - anios - 1;

  const [solicitudes, facturas, contrapartes, declaraciones, balanzas, total, conXml, conImpuestos, conContraparte, conVigencia, opinion, catalogo, cuentas, empleados] =
    await Promise.all([
      prisma.satSyncRequest.findMany({
        where: { companyId, tipo: { in: ["EMITIDOS", "RECIBIDOS"] }, year: { gte: anioMin } },
        select: { year: true, month: true, tipo: true, status: true, cfdisFound: true, errorMessage: true, desde: true, hasta: true, createdAt: true, updatedAt: true },
      }),
      prisma.$queryRaw<Array<{ year: number; month: number; n: bigint }>>`
        SELECT EXTRACT(YEAR FROM "fecha")::int AS year,
               EXTRACT(MONTH FROM "fecha")::int AS month,
               COUNT(*) AS n
        FROM "Invoice"
        WHERE "companyId" = ${companyId}
        GROUP BY 1, 2
      `,
      prisma.$queryRaw<Array<{ clientes: bigint; proveedores: bigint }>>`
        SELECT COUNT(DISTINCT "contraparteRfc") FILTER (WHERE "tipo" = 'INGRESO') AS clientes,
               COUNT(DISTINCT "contraparteRfc") FILTER (WHERE "tipo" = 'EGRESO') AS proveedores
        FROM "Invoice"
        WHERE "companyId" = ${companyId} AND "contraparteRfc" IS NOT NULL
      `,
      prisma.taxDeclaration.findMany({
        where: { companyId, tipo: { in: ["IVA_MENSUAL", "ISR_PROVISIONAL"] }, status: { in: ["FILED", "PAID"] } },
        select: { periodo: true },
        distinct: ["periodo"],
      }),
      prisma.ceBalanzaMes.groupBy({ by: ["anio", "mes"], where: { companyId } }),
      prisma.invoice.count({ where: { companyId } }),
      prisma.invoice.count({ where: { companyId, rawXml: { not: null } } }),
      prisma.invoice.count({ where: { companyId, taxes: { some: {} } } }),
      prisma.invoice.count({ where: { companyId, contraparteNombre: { not: null } } }),
      prisma.invoice.count({ where: { companyId, vigenciaCheckedAt: { not: null } } }),
      prisma.complianceSnapshot.findFirst({
        where: { companyId, tipo: "SAT_OPINION" },
        orderBy: { fetchedAt: "desc" },
        select: { resultado: true, fetchedAt: true },
      }),
      // El catálogo de cuentas presentado al SAT (CE), ya aplicado.
      prisma.ceArchivo.findFirst({
        where: { companyId, tipo: "CT", importadoEn: { not: null } },
        orderBy: [{ anio: "desc" }, { mes: "desc" }],
        select: { anio: true, mes: true },
      }),
      prisma.chartAccount.count({ where: { companyId, isActive: true } }),
      // Empleados (los crea la importación de los recibos de nómina timbrados).
      prisma.employee.count({ where: { companyId, isActive: true } }),
    ]);

  const meses = mesesHistorial({
    hoy,
    anios,
    inicio: company.fechaInicioOperaciones,
    solicitudes: solicitudes as SolicitudMes[],
    facturas: new Map(facturas.map((r) => [`${r.year}-${r.month}`, Number(r.n)])),
    declaraciones: new Set(declaraciones.map((d) => d.periodo).filter((p) => /^\d{4}-\d{2}$/.test(p))),
    balanzas: new Set(balanzas.map((b) => `${b.anio}-${b.mes}`)),
  });

  // Cuánto tarda el SAT: esta empresa si ya tiene historia; si no, el portafolio.
  const respuestaSat = medianaRespuestaSat(solicitudes) ?? (await medianaPortafolio()) ?? MS_RESPUESTA_SAT_DEFAULT;

  const etapas = evaluarEtapas({
    companyId,
    total,
    conXml,
    conImpuestos,
    conContraparte,
    conVigencia,
    backfillCompleto: company.satBackfillCompletedAt != null,
  });

  return {
    empresa: { rfc: company.rfc, razonSocial: company.razonSocial, anios: company.satBackfillYears, conFiel: !!company.fielCer },
    meses,
    resumen: resumirHistorial(meses),
    conteos: {
      cfdis: total,
      clientes: Number(contrapartes[0]?.clientes ?? 0),
      proveedores: Number(contrapartes[0]?.proveedores ?? 0),
    },
    etapas: etapas.map((e) => ({ clave: e.clave, etiqueta: e.etiqueta, hechos: e.hechos, total: e.total, pct: e.pct, completa: e.completa })),
    opinion: opinion ? { resultado: opinion.resultado, fetchedAt: opinion.fetchedAt.toISOString() } : null,
    catalogo: catalogo ? { anio: catalogo.anio, mes: catalogo.mes, cuentas } : null,
    empleados,
    estimacion: estimarTiempos(meses, respuestaSat),
  };

}

export type EstadoAltaDatos = NonNullable<Awaited<ReturnType<typeof cargarEstadoAlta>>>;
