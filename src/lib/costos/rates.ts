// ─────────────────────────────────────────────────────────────────────────────
// Tarifas de costo-por-servir (unit economics). Todo en MICRO-USD (USD × 1e6),
// entero, para no perder precisión en costos sub-centavo de tokens. La conversión
// a MXN se hace al MOSTRAR, con el FIX de Banxico (no se fija aquí para que el
// histórico de costo no dependa del tipo de cambio del día).
//
// Versionado/git-tracked como las tarifas fiscales. Ajusta estos números a tus
// precios reales de contrato.
// ─────────────────────────────────────────────────────────────────────────────

export const MICRO_USD = 1_000_000;

/** Precio Anthropic por 1,000,000 de tokens (USD). Aproximado — ajústalo. */
export const ANTHROPIC_PRICES_USD_PER_MTOK: Record<string, { in: number; out: number }> = {
  "claude-sonnet-4-5": { in: 3, out: 15 },
  "claude-opus-4-1": { in: 15, out: 75 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};
const DEFAULT_MODEL = "claude-sonnet-4-5";

/**
 * Costo de una llamada LLM en micro-USD: tokens × (USD por millón de tokens).
 * Como micro-USD = USD × 1e6 y el precio es por 1e6 tokens, el factor 1e6 se
 * cancela: micro-USD = inTok·in + outTok·out.
 */
export function llmCostMicroUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = ANTHROPIC_PRICES_USD_PER_MTOK[model] ?? ANTHROPIC_PRICES_USD_PER_MTOK[DEFAULT_MODEL];
  return Math.round(inputTokens * p.in + outputTokens * p.out);
}

/** Precio Syntage por extracción (USD). VERIFY: ponlo en tu precio de contrato. */
export const SYNTAGE_EXTRACTION_USD = 0.5;

export function syntageExtractionMicroUsd(): number {
  return Math.round(SYNTAGE_EXTRACTION_USD * MICRO_USD);
}

/** Convierte micro-USD → centavos MXN dado el tipo de cambio (pesos por USD). */
export function microUsdACentavosMxn(microUsd: number, fixMxnPorUsd: number): number {
  return Math.round((microUsd / MICRO_USD) * fixMxnPorUsd * 100);
}
