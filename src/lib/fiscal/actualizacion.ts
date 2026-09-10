// ─────────────────────────────────────────────────────────────────────────────
// Actualización por inflación — capa GENÉRICA sobre la serie INPC.
//
// La serie INPC vive en ./inpc (módulo del otro flujo, usado por la depreciación
// de activos). Ese módulo expone inpc(year, month) y un factor específico de
// depreciación (Art. 31). Aquí se agrega el factor GENÉRICO (Art. 17-A CFF) con
// entradas "YYYY-MM" para el resto de actualizaciones: pérdidas fiscales, CUFIN/
// CUCA, saldos a favor, dic→dic, etc. No duplica valores: ./inpc es la única
// serie versionada y cualquier periodo ausente falla cerrado con null.
// ─────────────────────────────────────────────────────────────────────────────

import { coberturaInpc, inpc as inpcYM } from "./inpc";

function parsePeriodo(periodo: string): [number, number] | null {
  const m = /^(\d{4})-(\d{2})$/.exec(periodo);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/** INPC de un periodo "YYYY-MM" from the canonical versioned series. */
export function inpcPeriodo(periodo: string): number | null {
  const p = parsePeriodo(periodo);
  if (!p) return null;
  return inpcYM(p[0], p[1]);
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
