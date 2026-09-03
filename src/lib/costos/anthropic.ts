// Envoltura de `anthropic.messages.create` (NO streaming) que registra el costo
// de la llamada de forma fire-and-forget. Para el chat (streaming) la métrica se
// toma de los eventos del stream, no de aquí.
//
// El `ctx` debe traer companyId y userId siempre que se conozcan: los topes de
// IA (src/lib/ai/guardia.ts) suman CostEvent por empresa y por usuario.

import type Anthropic from "@anthropic-ai/sdk";
import { recordLlmCost, type CostCtx } from "./record";

export async function meteredCreate(
  client: Anthropic,
  ctx: CostCtx,
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  const msg = await client.messages.create(params);
  void recordLlmCost(msg.model ?? String(params.model), msg.usage, ctx);
  return msg;
}
