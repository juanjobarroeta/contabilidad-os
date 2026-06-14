// ─────────────────────────────────────────────────────────────────────────────
// Registro de costo-por-servir. recordCost() es FIRE-AND-FORGET: nunca lanza ni
// bloquea la petición que está midiendo (un fallo al medir no debe romper el
// parseo de un acuse ni una extracción). Las funciones específicas calculan el
// costo con la tabla de tarifas y persisten un CostEvent.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { llmCostMicroUsd, syntageExtractionMicroUsd } from "./rates";

export interface CostCtx {
  companyId?: string | null;
  despachoId?: string | null;
  /** Etiqueta del origen, p.ej. "declaraciones.backfill" / "onboarding.parse_document". */
  subtipo?: string;
}

export async function recordCost(e: {
  categoria: "LLM" | "SYNTAGE";
  subtipo: string;
  unidades: number;
  costoMicroUsd: number;
  companyId?: string | null;
  despachoId?: string | null;
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
        meta: e.meta === undefined ? undefined : (e.meta as Prisma.InputJsonValue),
      },
    });
  } catch (err) {
    // Medir nunca debe tumbar la operación medida.
    console.error("[costos] recordCost falló:", err instanceof Error ? err.message : err);
  }
}

/** Registra el costo de una llamada LLM a partir del `usage` de la respuesta. */
export async function recordLlmCost(
  model: string,
  usage: { input_tokens?: number; output_tokens?: number } | null | undefined,
  ctx?: CostCtx,
): Promise<void> {
  const inTok = usage?.input_tokens ?? 0;
  const outTok = usage?.output_tokens ?? 0;
  if (!inTok && !outTok) return;
  await recordCost({
    categoria: "LLM",
    subtipo: ctx?.subtipo ?? "llm.call",
    unidades: inTok + outTok,
    costoMicroUsd: llmCostMicroUsd(model, inTok, outTok),
    companyId: ctx?.companyId,
    despachoId: ctx?.despachoId,
    meta: { model, inputTokens: inTok, outputTokens: outTok },
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
