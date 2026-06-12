// ─────────────────────────────────────────────────────────────────────────────
// Actualización por inflación — capa GENÉRICA sobre la serie INPC.
//
// La serie INPC vive en ./inpc (módulo del otro flujo, usado por la depreciación
// de activos). Ese módulo expone inpc(year, month) y un factor específico de
// depreciación (Art. 31). Aquí se agrega el factor GENÉRICO (Art. 17-A CFF) con
// entradas "YYYY-MM" para el resto de actualizaciones: pérdidas fiscales, CUFIN/
// CUCA, saldos a favor, dic→dic, etc. No se toca el módulo inpc.
//
// Suplemento: el módulo INPC aún carga sólo ene–ago de cada año (+ ene–may 2026);
// para habilitar la actualización general (que usa diciembre, etc.) se completan
// aquí los meses faltantes. Cuando ./inpc los incluya, su valor tiene precedencia.
// ─────────────────────────────────────────────────────────────────────────────

import { coberturaInpc, inpc as inpcYM } from "./inpc";

/** Meses aún no cargados en ./inpc, necesarios para la actualización general. */
const SUPLEMENTO_INPC: Record<string, number> = {
  "2024-09": 136.080, "2024-10": 136.828, "2024-11": 137.424, "2024-12": 137.949,
  "2025-09": 141.197, "2025-10": 141.708, "2025-11": 142.645, "2025-12": 143.042,
};

function parsePeriodo(periodo: string): [number, number] | null {
  const m = /^(\d{4})-(\d{2})$/.exec(periodo);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/** INPC de un periodo "YYYY-MM" (serie ./inpc, con suplemento de respaldo). */
export function inpcPeriodo(periodo: string): number | null {
  const p = parsePeriodo(periodo);
  if (!p) return null;
  return inpcYM(p[0], p[1]) ?? SUPLEMENTO_INPC[periodo] ?? null;
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Factor de actualización genérico (Art. 17-A CFF) = INPC[hasta] / INPC[desde],
 * redondeado al diezmilésimo. null si falta algún INPC (el llamador decide si
 * cae a nominal = 1).
 */
export function factorActualizacion(desde: string, hasta: string): number | null {
  const a = inpcPeriodo(desde);
  const b = inpcPeriodo(hasta);
  if (a === null || b === null || a === 0) return null;
  return r4(b / a);
}

/** Actualiza un monto de `desde` a `hasta`; null si falta INPC. */
export function actualizar(monto: number, desde: string, hasta: string): number | null {
  const f = factorActualizacion(desde, hasta);
  return f === null ? null : Math.round(monto * f * 100) / 100;
}

/** Inflación acumulada entre dos periodos (factor − 1), o null. */
export function inflacionAcumulada(desde: string, hasta: string): number | null {
  const f = factorActualizacion(desde, hasta);
  return f === null ? null : Math.round((f - 1) * 1e6) / 1e6;
}

/**
 * Meses que la serie INPC está atrasada respecto a `hoy`. Usa la cobertura del
 * módulo ./inpc (su último mes cargado). El INPC de un mes se publica a inicios
 * del siguiente, así que un atraso > ~2 meses indica que falta actualizar.
 */
export function mesesAtrasadoInpc(hoy: Date = new Date()): number {
  const cob = coberturaInpc();
  if (!cob) return Number.POSITIVE_INFINITY;
  return (hoy.getUTCFullYear() - cob.year) * 12 + (hoy.getUTCMonth() + 1 - cob.month);
}
