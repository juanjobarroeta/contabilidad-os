// ─────────────────────────────────────────────────────────────────────────────
// INPC — Índice Nacional de Precios al Consumidor (base 2ª quincena julio 2018
// = 100). Drives la actualización por inflación (Art. 17-A CFF): depreciación de
// inversiones, pérdidas fiscales, CUFIN/CUCA, saldos a favor, etc.
//
// Correctness-critical → git-tracked y revisado en PR (igual que tarifas.ts),
// NUNCA escrito en una DB silenciosamente. INEGI lo publica los días 10 y 25 en
// el DOF; agregar el mes nuevo por PR (~día 10). El cron mensual
// inpc-refresh.yml falla cuando la serie se atrasa, como recordatorio.
// ─────────────────────────────────────────────────────────────────────────────

/** INPC mensual por periodo "YYYY-MM". Fuente: INEGI (DOF). */
export const INPC: Record<string, number> = {
  "2024-01": 133.555, "2024-02": 133.681, "2024-03": 134.065, "2024-04": 134.336,
  "2024-05": 134.087, "2024-06": 134.594, "2024-07": 136.003, "2024-08": 136.013,
  "2024-09": 136.080, "2024-10": 136.828, "2024-11": 137.424, "2024-12": 137.949,
  "2025-01": 138.343, "2025-02": 138.726, "2025-03": 139.161, "2025-04": 139.620,
  "2025-05": 140.012, "2025-06": 140.405, "2025-07": 140.780, "2025-08": 140.867,
  "2025-09": 141.197, "2025-10": 141.708, "2025-11": 142.645, "2025-12": 143.042,
  "2026-01": 143.588, "2026-02": 144.307, "2026-03": 145.544, "2026-04": 145.831,
  "2026-05": 145.527,
};

/** INPC del periodo "YYYY-MM", o null si no está en la serie. */
export function inpc(periodo: string): number | null {
  return INPC[periodo] ?? null;
}

/** Último periodo cargado en la serie ("YYYY-MM"). */
export function ultimoPeriodo(): string {
  return Object.keys(INPC).sort().at(-1)!;
}

/**
 * Factor de actualización (Art. 17-A CFF) = INPC[hasta] / INPC[desde],
 * redondeado al diezmilésimo (4 decimales), convención del SAT. Devuelve null si
 * falta algún periodo en la serie.
 */
export function factorActualizacion(desde: string, hasta: string): number | null {
  const a = INPC[desde];
  const b = INPC[hasta];
  if (a === undefined || b === undefined) return null;
  return Math.round((b / a) * 10000) / 10000;
}

/** Actualiza un monto de `desde` a `hasta`; null si falta INPC. */
export function actualizar(monto: number, desde: string, hasta: string): number | null {
  const f = factorActualizacion(desde, hasta);
  if (f === null) return null;
  return Math.round(monto * f * 100) / 100;
}

/** Inflación acumulada entre dos periodos (factor − 1), o null. */
export function inflacionAcumulada(desde: string, hasta: string): number | null {
  const f = factorActualizacion(desde, hasta);
  return f === null ? null : Math.round((f - 1) * 1e6) / 1e6;
}

/**
 * Meses que la serie está atrasada respecto a `hoy` (default: ahora). El INPC de
 * un mes se publica a inicios del mes siguiente, así que la serie debería tener
 * el mes anterior; un atraso > ~2 meses indica que falta actualizar.
 */
export function mesesAtrasado(hoy: Date = new Date()): number {
  const [y, m] = ultimoPeriodo().split("-").map(Number);
  return (hoy.getUTCFullYear() - y) * 12 + (hoy.getUTCMonth() + 1 - m);
}
