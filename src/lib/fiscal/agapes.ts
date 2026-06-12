// ─────────────────────────────────────────────────────────────────────────────
// AGAPES — exención anual (Art. 74 LISR). Computed in múltiplos de UMA anual,
// resolved from the rules layer (uma.valor + agapes.exencion.*). PF: 40 UMA.
// PM: 20 UMA por socio, tope 200 UMA. The ISR engine consumes `exencionMXN` to
// reduce the gravable base — this module only computes the exempt amount.
// ─────────────────────────────────────────────────────────────────────────────

import { getRule, type Contexto, type Tabla } from "./rules";

export interface ExencionAgapes {
  /** Monto exento en el ejercicio, MXN. */
  exencionMXN: number;
  /** UMA anual usada. */
  umaAnual: number;
  /** Factor efectivo en UMA (ya con tope/socios aplicados). */
  factorUMA: number;
  /** Tope en UMA (solo PM). */
  topeUMA?: number;
  /** Socios considerados (solo PM). */
  socios?: number;
  fundamento: { ley: string; articulo: string; fraccion?: string };
  /** True solo si tanto la UMA como el factor están verificados. */
  verificado: boolean;
}

/**
 * Exención anual de AGAPES para el contexto. Devuelve null si la empresa no es
 * AGAPES (no hay regla aplicable) o si no se resuelve la UMA. Para PM pasa el
 * número de socios en `opts.socios` (default 1).
 */
export function exencionAgapesAnual(
  ctx: Contexto,
  opts?: { socios?: number },
): ExencionAgapes | null {
  const uma = getRule<Tabla>("uma.valor", ctx);
  const factor = getRule<number>("agapes.exencion.factor_uma_anual", ctx);
  if (!uma || !factor) return null; // no AGAPES, o sin UMA vigente

  const umaAnual = uma.valor.anual;

  if (ctx.tipoPersona === "PM") {
    const socios = Math.max(1, Math.floor(opts?.socios ?? 1));
    const tope = getRule<number>("agapes.exencion.tope_uma_anual", ctx);
    const topeUMA = tope?.valor;
    let factorUMA = factor.valor * socios;
    if (topeUMA !== undefined) factorUMA = Math.min(factorUMA, topeUMA);
    return {
      exencionMXN: Math.round(factorUMA * umaAnual * 100) / 100,
      umaAnual,
      factorUMA,
      topeUMA,
      socios,
      fundamento: factor.fundamento,
      verificado: uma.verificado && factor.verificado && (tope?.verificado ?? true),
    };
  }

  // PF: 40 UMA anuales, sin tope por socios.
  const factorUMA = factor.valor;
  return {
    exencionMXN: Math.round(factorUMA * umaAnual * 100) / 100,
    umaAnual,
    factorUMA,
    fundamento: factor.fundamento,
    verificado: uma.verificado && factor.verificado,
  };
}
