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

/** Precio Facturapi por timbre, en MXN ($0.60 por CFDI/recibo). Es nativo en
 *  pesos; el resto del sistema trabaja en micro-USD, así que convertimos con un
 *  tipo de cambio de REFERENCIA fijo (no el FIX del día) para que el histórico
 *  sea estable. El drift al mostrar es de centavos — irrelevante para un timbre.
 *  La base mensual de Facturapi (~$299/mo, RFC emisores ilimitados) es un costo
 *  fijo de plataforma, no por empresa, así que no entra aquí. */
export const FACTURAPI_TIMBRE_MXN = 0.6;
const MXN_POR_USD_REF = 20;

export function facturapiTimbreMicroUsd(n = 1): number {
  return Math.round((FACTURAPI_TIMBRE_MXN / MXN_POR_USD_REF) * MICRO_USD * n);
}

/**
 * Twilio WhatsApp por mensaje enviado (USD). Estimación all-in de una plantilla
 * de utilidad (utility template): tarifa de conversación de WhatsApp + fee de
 * Twilio. Las respuestas dentro de la ventana de servicio de 24h (freeform) son
 * más baratas, pero estimamos de forma uniforme para no complicar la medición.
 * Si se desea distinguir, `TWILIO_WHATSAPP_TEMPLATE_USD` cubre el envío proactivo
 * con plantilla y `TWILIO_WHATSAPP_SESSION_USD` la respuesta dentro de ventana.
 * Override por entorno con TWILIO_WHATSAPP_MESSAGE_USD (aplica a ambos si no se
 * fijan los específicos). Ajusta a tu contrato real.
 */
export const TWILIO_WHATSAPP_MESSAGE_USD = Number(
  process.env.TWILIO_WHATSAPP_MESSAGE_USD ?? 0.012,
);
export const TWILIO_WHATSAPP_TEMPLATE_USD = Number(
  process.env.TWILIO_WHATSAPP_TEMPLATE_USD ?? TWILIO_WHATSAPP_MESSAGE_USD,
);
export const TWILIO_WHATSAPP_SESSION_USD = Number(
  process.env.TWILIO_WHATSAPP_SESSION_USD ?? TWILIO_WHATSAPP_MESSAGE_USD,
);

/** Costo en micro-USD de un mensaje de WhatsApp. `kind` distingue una plantilla
 *  proactiva (fuera de ventana) de una respuesta dentro de la ventana de servicio. */
export function twilioWhatsappMicroUsd(kind: "template" | "session" = "template"): number {
  const usd = kind === "session" ? TWILIO_WHATSAPP_SESSION_USD : TWILIO_WHATSAPP_TEMPLATE_USD;
  return Math.round(usd * MICRO_USD);
}

/** Convierte micro-USD → centavos MXN dado el tipo de cambio (pesos por USD). */
export function microUsdACentavosMxn(microUsd: number, fixMxnPorUsd: number): number {
  return Math.round((microUsd / MICRO_USD) * fixMxnPorUsd * 100);
}
