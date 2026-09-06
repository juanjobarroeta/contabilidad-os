// ─────────────────────────────────────────────────────────────────────────────
// SAEH — el mes que se reporta: anio/mes de la query (o el mes local en curso)
// y el filtro de los egresos hospitalarios de ese mes. Vive fuera de las rutas
// porque Next no admite exports ajenos a los handlers en un route.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma } from "@prisma/client";
import { partesLocales, rangoMesLocal } from "../tz";

/** anio/mes de la query o el mes local en curso; null si vienen mal. */
export function periodoDeQuery(searchParams: URLSearchParams, hoy: Date = new Date()): { anio: number; mes: number } | null {
  const p = partesLocales(hoy);
  const anio = searchParams.get("anio") ? Number(searchParams.get("anio")) : p.y;
  const mes = searchParams.get("mes") ? Number(searchParams.get("mes")) : p.m;
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100 || !Number.isInteger(mes) || mes < 1 || mes > 12) return null;
  return { anio, mes };
}

/**
 * Egresos hospitalarios del mes local: HOSPITALIZACION y AMBULATORIO con fecha
 * de alta en el mes (URGENCIAS y CONSULTA no son egreso hospitalario).
 */
export function whereEgresosDelMes(anio: number, mes: number): Prisma.HospEpisodioWhereInput {
  const { desde, hasta } = rangoMesLocal(anio, mes);
  return { tipo: { in: ["HOSPITALIZACION", "AMBULATORIO"] }, estado: { not: "CANCELADO" }, fechaAlta: { gte: desde, lt: hasta } };
}
