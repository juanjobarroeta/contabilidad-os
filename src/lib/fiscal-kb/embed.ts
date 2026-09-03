// Embeddings for the fiscal knowledge base. Anthropic has no embeddings
// endpoint, so we pair Claude (generation) with OpenAI (embeddings) — the
// OPENAI_API_KEY is already part of the stack (Whisper voice notes). The
// embedder is isolated behind this module so swapping to Voyage later is a
// one-file change (+ vector dim migration + re-embed).
//
// Design doc: docs/FISCAL-KNOWLEDGE-BASE.md §7.

import { recordEmbeddingCost, type CostCtx } from "@/lib/costos/record";

const EMBEDDING_MODEL = "text-embedding-3-small";
/** Must match `vector(N)` on FiscalChunk.embedding in prisma/schema.prisma. */
export const EMBEDDING_DIM = 1536;

const BATCH_SIZE = 64;
const MAX_RETRIES = 3;

async function embedBatch(texts: string[], cost?: CostCtx): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY no configurada — requerida para embeddings del knowledge base fiscal");
  // Se mide con los tokens que reporta la API; si no vienen, ~4 caracteres/token.
  const tokensEstimados = Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4);

  for (let attempt = 1; ; attempt++) {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
    });
    if (res.ok) {
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[]; usage?: { total_tokens?: number } };
      void recordEmbeddingCost(json.usage?.total_tokens ?? tokensEstimados, { ...cost, subtipo: cost?.subtipo ?? "openai.embedding" });
      // API preserves order, but sort by index defensively.
      return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    }
    const body = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`Embeddings API ${res.status}: ${body.slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

/** Embed many texts in batches. Order of the result matches the input. */
export async function embedTexts(texts: string[], cost?: CostCtx): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    out.push(...(await embedBatch(texts.slice(i, i + BATCH_SIZE), cost)));
  }
  return out;
}

// Caché LRU en memoria del embedding de la CONSULTA. Dos razones: (1) OpenAI
// no es determinista — la misma pregunta embebida dos veces cambia el orden de
// vecinos casi empatados, y el eval flipeaba 2–3 preguntas entre corridas con
// la misma KB; (2) las preguntas repetidas del chat no pagan el embedding (un
// hit no registra costo: no hubo llamada). Vive mientras viva el proceso.
const QUERY_CACHE_MAX = 500;
const queryCache = new Map<string, number[]>();

export async function embedQuery(query: string, cost?: CostCtx): Promise<number[]> {
  const key = query.trim();
  const hit = queryCache.get(key);
  if (hit) {
    queryCache.delete(key);
    queryCache.set(key, hit); // refresca el orden LRU
    return hit;
  }
  const [v] = await embedBatch([key], cost);
  queryCache.set(key, v);
  if (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value!);
  return v;
}

/** pgvector literal: '[0.1,0.2,…]' — pass as ${literal}::vector in raw SQL. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
