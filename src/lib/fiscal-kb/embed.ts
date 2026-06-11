// Embeddings for the fiscal knowledge base. Anthropic has no embeddings
// endpoint, so we pair Claude (generation) with OpenAI (embeddings) — the
// OPENAI_API_KEY is already part of the stack (Whisper voice notes). The
// embedder is isolated behind this module so swapping to Voyage later is a
// one-file change (+ vector dim migration + re-embed).
//
// Design doc: docs/FISCAL-KNOWLEDGE-BASE.md §7.

const EMBEDDING_MODEL = "text-embedding-3-small";
/** Must match `vector(N)` on FiscalChunk.embedding in prisma/schema.prisma. */
export const EMBEDDING_DIM = 1536;

const BATCH_SIZE = 64;
const MAX_RETRIES = 3;

async function embedBatch(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY no configurada — requerida para embeddings del knowledge base fiscal");

  for (let attempt = 1; ; attempt++) {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
    });
    if (res.ok) {
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
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
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    out.push(...(await embedBatch(texts.slice(i, i + BATCH_SIZE))));
  }
  return out;
}

export async function embedQuery(query: string): Promise<number[]> {
  const [v] = await embedBatch([query]);
  return v;
}

/** pgvector literal: '[0.1,0.2,…]' — pass as ${literal}::vector in raw SQL. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
