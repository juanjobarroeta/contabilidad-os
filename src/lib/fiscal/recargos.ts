// ─────────────────────────────────────────────────────────────────────────────
// Recargos — tasa de prórroga (LIF) y de mora (Art. 21 CFF = prórroga × 1.5),
// más los tramos de pago a plazos (Art. 66 CFF). Valores en
// src/lib/fiscal/datos/recargos-<Y>.json, generados de la LIF vigente en la
// Cámara de Diputados por `npm run fiscal:valores` y revisados en PR.
//
// Cálculo (Art. 21 CFF): los recargos se causan por cada mes o fracción que
// transcurra desde que debió pagarse, sobre la contribución ACTUALIZADA, hasta
// por cinco años; la tasa es la de mora del mes en que se causan.
// ─────────────────────────────────────────────────────────────────────────────

import { RECARGOS_GENERADOS } from "./datos";
import { tasaMoraDesdeProrroga } from "./fuentes/lif";

export { tasaMoraDesdeProrroga };

export interface RecargoVersionado {
  ejercicio: number;
  vigenciaDesde: string;
  vigenciaHasta: string | null;
  fuente: string;
  url: string | null;
  verificado: boolean;
  /** Artículo de la LIF («11» en 2026; «8» hasta 2025). */
  articulo: string;
  /** Tasa mensual de prórroga (decimal). */
  prorroga: number;
  /** Tasa mensual de mora = prórroga × 1.5 (Art. 21 CFF), redondeada a 4 decimales. */
  mora: number;
  parcialidades: { hastaMeses: number | null; tasa: number }[];
}

export const RECARGOS: RecargoVersionado[] = RECARGOS_GENERADOS;

/** Tope de meses de recargos por mora (Art. 21 CFF: hasta cinco años). */
export const RECARGOS_MESES_TOPE = 60;

export function tasasRecargos(fecha: string | Date = new Date()): RecargoVersionado | null {
  const iso = typeof fecha === "string" ? fecha : fecha.toISOString().slice(0, 10);
  const c = RECARGOS.filter((r) => r.vigenciaDesde <= iso && (r.vigenciaHasta === null || iso <= r.vigenciaHasta));
  if (c.length === 0) return null;
  return c.reduce((best, r) => (r.vigenciaDesde > best.vigenciaDesde ? r : best));
}

/**
 * Recargos por mora sobre un monto YA actualizado, por `meses` de mora (cada mes
 * o fracción cuenta entero), con la tasa vigente a `fecha`. Simplificación
 * documentada: usa una sola tasa (la vigente), no la de cada mes transcurrido.
 */
export function recargosPorMora(montoActualizado: number, meses: number, fecha: string | Date = new Date()): { recargos: number; tasaMensual: number; meses: number } | null {
  const t = tasasRecargos(fecha);
  if (!t || montoActualizado <= 0) return null;
  const m = Math.min(Math.max(Math.ceil(meses), 0), RECARGOS_MESES_TOPE);
  return { recargos: Math.round(montoActualizado * t.mora * m * 100) / 100, tasaMensual: t.mora, meses: m };
}

export function coberturaRecargos(): { ejercicio: number; verificado: boolean } | null {
  if (RECARGOS.length === 0) return null;
  const u = RECARGOS.reduce((best, r) => (r.ejercicio > best.ejercicio ? r : best));
  return { ejercicio: u.ejercicio, verificado: u.verificado };
}
