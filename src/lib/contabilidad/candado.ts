// ─────────────────────────────────────────────────────────────────────────────
// Candado de ejercicio (AccountingPeriodStatus.CLOSED) — Fase 3.2.
//
// Hasta ahora CLOSED existía en el enum pero NADIE lo escribía: todo periodo
// vivía en DRAFT o POSTED, así que un mes ya declarado ante el SAT podía
// re-postearse (y cambiar de cifras) sin que nada lo impidiera. Aquí vive el
// cierre DEFINITIVO del ejercicio y la guarda que todas las rutas de escritura
// consultan antes de tocar el libro.
//
// Las REGLAS (¿se puede cerrar?) son puras y viven en ejercicio.ts, para que el
// panel de cliente las use sin arrastrar Prisma al bundle. Este módulo es el
// lado que escribe.
//
// Decisiones:
//   - El candado es por EJERCICIO, no por mes: cerrar 2025 marca CLOSED sus 13
//     periodos (12 meses + el mes 13 del asiento de cierre). Los meses que
//     todavía no tenían fila se CREAN cerrados, para que un postMonth posterior
//     sobre un mes "vacío" del ejercicio cerrado también choque contra la
//     guarda — si no, quedaría una puerta abierta por donde se cuelan asientos
//     a un año ya declarado.
//   - Cerrar EXIGE que el ejercicio esté completo: ningún mes con asientos en
//     borrador y el asiento de cierre (mes 13) ya generado.
//   - Reabrir es reversible pero AUDITADO: devuelve cada periodo a POSTED (o a
//     DRAFT si estaba vacío) y deja rastro en bitácora. No borra nada.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import { registrarBitacora } from "../audit";
import {
  EjercicioError,
  MESES_EJERCICIO,
  PeriodoCerradoError,
  evaluarCierreEjercicio,
} from "./ejercicio";

export {
  EjercicioError,
  MESES_EJERCICIO,
  PeriodoCerradoError,
  evaluarCierreEjercicio,
  type EvaluacionCierre,
  type PeriodoResumen,
} from "./ejercicio";

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Guarda que TODA ruta de escritura al libro debe llamar antes de insertar,
 * borrar o re-postear asientos. Acepta el cliente de una transacción para que
 * la comprobación viva dentro de la misma transacción que la escritura.
 */
export async function assertPeriodoAbierto(
  db: Db,
  companyId: string,
  year: number,
  month: number
): Promise<void> {
  const period = await db.accountingPeriod.findUnique({
    where: { companyId_year_month: { companyId, year, month } },
    select: { status: true },
  });
  if (period?.status === "CLOSED") throw new PeriodoCerradoError(year, month);
}

/**
 * Estado del candado de un ejercicio, para que el UI sepa qué ofrecer sin
 * duplicar las reglas.
 */
export async function estadoEjercicio(companyId: string, year: number) {
  const periodos = await prisma.accountingPeriod.findMany({
    where: { companyId, year },
    select: { month: true, status: true, entriesCount: true },
    orderBy: { month: "asc" },
  });
  return { year, periodos, ...evaluarCierreEjercicio(periodos) };
}

/**
 * Cierra el ejercicio: marca CLOSED los 13 periodos del año, creando los que
 * falten (ver nota de arriba — un mes sin fila sería una puerta abierta).
 */
export async function cerrarEjercicio(
  companyId: string,
  year: number,
  opts: { userId?: string; req?: Request } = {}
): Promise<{ periodos: number }> {
  const periodos = await prisma.accountingPeriod.findMany({
    where: { companyId, year },
    select: { month: true, status: true, entriesCount: true },
  });
  const evaluacion = evaluarCierreEjercicio(periodos);
  if (!evaluacion.puedeCerrar) {
    throw new EjercicioError(evaluacion.motivo ?? "No se puede cerrar el ejercicio");
  }

  await prisma.$transaction(async (tx) => {
    for (const month of MESES_EJERCICIO) {
      await tx.accountingPeriod.upsert({
        where: { companyId_year_month: { companyId, year, month } },
        update: { status: "CLOSED" },
        create: { companyId, year, month, status: "CLOSED" },
      });
    }
  });

  registrarBitacora({
    companyId,
    userId: opts.userId,
    accion: "contabilidad.ejercicio.cerrar",
    entidad: "AccountingPeriod",
    entidadId: `${companyId}:${year}`,
    detalle: { year, periodosPrevios: periodos.length },
    req: opts.req,
  });

  return { periodos: MESES_EJERCICIO.length };
}

/**
 * Reabre el ejercicio: CLOSED → POSTED en los periodos con asientos y → DRAFT
 * en los vacíos. No borra nada; sólo devuelve la capacidad de corregir.
 */
export async function reabrirEjercicio(
  companyId: string,
  year: number,
  opts: { motivo?: string; userId?: string; req?: Request } = {}
): Promise<{ reabiertos: number }> {
  const cerrados = await prisma.accountingPeriod.findMany({
    where: { companyId, year, status: "CLOSED" },
    select: { id: true, month: true, entriesCount: true },
  });
  if (cerrados.length === 0) throw new EjercicioError(`El ejercicio ${year} no está cerrado.`);

  await prisma.$transaction(async (tx) => {
    const conAsientos = cerrados.filter((p) => p.entriesCount > 0).map((p) => p.id);
    const vacios = cerrados.filter((p) => p.entriesCount === 0).map((p) => p.id);
    if (conAsientos.length > 0) {
      await tx.accountingPeriod.updateMany({ where: { id: { in: conAsientos } }, data: { status: "POSTED" } });
    }
    if (vacios.length > 0) {
      await tx.accountingPeriod.updateMany({ where: { id: { in: vacios } }, data: { status: "DRAFT" } });
    }
  });

  registrarBitacora({
    companyId,
    userId: opts.userId,
    accion: "contabilidad.ejercicio.reabrir",
    entidad: "AccountingPeriod",
    entidadId: `${companyId}:${year}`,
    detalle: { year, reabiertos: cerrados.length, motivo: opts.motivo ?? null },
    req: opts.req,
  });

  return { reabiertos: cerrados.length };
}
