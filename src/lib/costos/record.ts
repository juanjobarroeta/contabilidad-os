// ─────────────────────────────────────────────────────────────────────────────
// Registro de costo-por-servir. recordCost() es FIRE-AND-FORGET: nunca lanza ni
// bloquea la petición que está midiendo (un fallo al medir no debe romper el
// parseo de un acuse ni una extracción). Las funciones específicas calculan el
// costo con la tabla de tarifas y persisten un CostEvent.
//
// Atribución: SIEMPRE que se conozca, pasar `companyId` y `userId`. Los topes de
// IA (src/lib/ai/guardia.ts) suman CostEvent por empresa (mes) y por usuario
// (día/mes); un evento sin atribución es gasto que ningún tope ve.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  llmCostMicroUsd,
  syntageExtractionMicroUsd,
  facturapiTimbreMicroUsd,
  whisperMicroUsd,
  embeddingMicroUsd,
} from "./rates";

export interface CostCtx {
  companyId?: string | null;
  despachoId?: string | null;
  /** Usuario que disparó la operación (topes por usuario y gasto pre-empresa). */
  userId?: string | null;
  /** Etiqueta del origen, p.ej. "declaraciones.backfill" / "onboarding.parse_document". */
  subtipo?: string;
}

export type CostCategoria = "LLM" | "SYNTAGE" | "FACTURAPI" | "TWILIO" | "OPENAI";

export async function recordCost(e: {
  categoria: CostCategoria;
  subtipo: string;
  unidades: number;
  costoMicroUsd: number;
  companyId?: string | null;
  despachoId?: string | null;
  userId?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.costEvent.create({
      data: {
        categoria: e.categoria,
        subtipo: e.subtipo,
        unidades: e.unidades,
        costoMicroUsd: e.costoMicroUsd,
        companyId: e.companyId ?? null,
        despachoId: e.despachoId ?? null,
        userId: e.userId ?? null,
        meta: e.meta === undefined ? undefined : (e.meta as Prisma.InputJsonValue),
      },
    });
  } catch (err) {
    // Medir nunca debe tumbar la operación medida.
    console.error("[costos] recordCost falló:", err instanceof Error ? err.message : err);
  }
}

/** `usage` de una respuesta de Anthropic, incluidos los tokens de prompt caching. */
export type LlmUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
} | null | undefined;

/** Registra el costo de una llamada LLM a partir del `usage` de la respuesta. */
export async function recordLlmCost(model: string, usage: LlmUsage, ctx?: CostCtx): Promise<void> {
  const inTok = usage?.input_tokens ?? 0;
  const outTok = usage?.output_tokens ?? 0;
  const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage?.cache_read_input_tokens ?? 0;
  if (!inTok && !outTok && !cacheWriteTokens && !cacheReadTokens) return;
  await recordCost({
    categoria: "LLM",
    subtipo: ctx?.subtipo ?? "llm.call",
    unidades: inTok + outTok + cacheWriteTokens + cacheReadTokens,
    costoMicroUsd: llmCostMicroUsd(model, inTok, outTok, { cacheWriteTokens, cacheReadTokens }),
    companyId: ctx?.companyId,
    despachoId: ctx?.despachoId,
    userId: ctx?.userId,
    meta: { model, inputTokens: inTok, outputTokens: outTok, cacheWriteTokens, cacheReadTokens },
  });
}

/** Registra una transcripción de Whisper (OpenAI), por segundos de audio. */
export async function recordWhisperCost(segundos: number, ctx?: CostCtx): Promise<void> {
  await recordCost({
    categoria: "OPENAI",
    subtipo: ctx?.subtipo ?? "openai.whisper",
    unidades: segundos,
    costoMicroUsd: whisperMicroUsd(segundos),
    companyId: ctx?.companyId,
    despachoId: ctx?.despachoId,
    userId: ctx?.userId,
  });
}

/** Registra una llamada de embeddings (OpenAI), por tokens facturados. */
export async function recordEmbeddingCost(tokens: number, ctx?: CostCtx): Promise<void> {
  if (tokens <= 0) return;
  await recordCost({
    categoria: "OPENAI",
    subtipo: ctx?.subtipo ?? "openai.embedding",
    unidades: tokens,
    costoMicroUsd: embeddingMicroUsd(tokens),
    companyId: ctx?.companyId,
    despachoId: ctx?.despachoId,
    userId: ctx?.userId,
  });
}

/** Registra el costo de una extracción de Syntage. */
export async function recordSyntageExtraction(extractor: string, ctx?: CostCtx): Promise<void> {
  await recordCost({
    categoria: "SYNTAGE",
    subtipo: `syntage.extraction.${extractor}`,
    unidades: 1,
    costoMicroUsd: syntageExtractionMicroUsd(),
    companyId: ctx?.companyId,
    despachoId: ctx?.despachoId,
  });
}

/**
 * Registra el costo de timbre(s) de Facturapi. tipo: "factura" (CFDI de
 * ingreso/egreso), "nomina" (recibo) o "pago" (REP). Fire-and-forget — nunca
 * rompe el timbrado que está midiendo.
 */
export async function recordTimbrado(
  tipo: "factura" | "nomina" | "pago",
  n = 1,
  ctx?: CostCtx,
): Promise<void> {
  if (n <= 0) return;
  await recordCost({
    categoria: "FACTURAPI",
    subtipo: `facturapi.timbre.${tipo}`,
    unidades: n,
    costoMicroUsd: facturapiTimbreMicroUsd(n),
    companyId: ctx?.companyId,
    despachoId: ctx?.despachoId,
  });
}
