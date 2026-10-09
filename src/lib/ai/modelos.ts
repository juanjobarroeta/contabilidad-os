// ─────────────────────────────────────────────────────────────────────────────
// Modelos por tipo de trabajo (un solo lugar para cambiarlos).
//
//   AGENTE  — copiloto, WhatsApp, pasada del contador, intake: razonan y usan
//             herramientas. Opus 5.5 ($4/$20) en vez de Fable 5 ($10/$50).
//   LECTOR  — lee PDFs/imágenes y devuelve JSON (estados de cuenta, CFDI, CSF,
//             nómina, acuses). Sonnet 5.5 ($2/$10) en vez de Sonnet 4.5 ($3/$15).
//   RAPIDO  — clasificar, resumir, reordenar, verificar. Haiku 5.5
//             ($0.10/$0.50) en vez de Haiku 4.5 ($1/$5).
//
// Cada uno sigue aceptando su variable de entorno de siempre para revertir sin
// desplegar código.
// ─────────────────────────────────────────────────────────────────────────────

import type Anthropic from "@anthropic-ai/sdk";

// Para revertir una clase completa sin desplegar: AI_AGENTE_MODEL,
// AI_LECTOR_MODEL o AI_RAPIDO_MODEL en Railway (p. ej. "claude-sonnet-4-5").
export const MODELO_AGENTE = process.env.AI_AGENTE_MODEL?.trim() || "claude-opus-5-5";
export const MODELO_LECTOR = process.env.AI_LECTOR_MODEL?.trim() || "claude-sonnet-5-5";
export const MODELO_RAPIDO = process.env.AI_RAPIDO_MODEL?.trim() || "claude-haiku-5-5";

/**
 * Sonnet 5.5 y Haiku 5.5 piensan por defecto, y el pensamiento se cobra como
 * salida. Para extraer o clasificar no hace falta: se apaga (Haiku 5.5 acepta
 * `disabled`; Sonnet 5.5 lo rechaza y usa `between_tools`). Otros modelos no
 * llevan el parámetro (Opus 5.5 no permite apagarlo; los 4.x no piensan).
 */
export function sinRazonamiento(model: string): { thinking?: Anthropic.ThinkingConfigParam } {
  if (model.startsWith("claude-haiku-5-5")) return { thinking: { type: "disabled" } };
  if (model.startsWith("claude-sonnet-5-5")) return { thinking: { type: "between_tools" } as unknown as Anthropic.ThinkingConfigParam };
  return {};
}

/** Agrega `sinRazonamiento` si la llamada no configuró `thinking` por su cuenta. */
export function ajustarParams<T extends { model: string; thinking?: unknown }>(params: T): T {
  return params.thinking === undefined ? { ...params, ...sinRazonamiento(String(params.model)) } : params;
}
