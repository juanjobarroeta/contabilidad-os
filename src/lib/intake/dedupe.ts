import { prisma } from "@/lib/prisma";
import { embedTexts, toVectorLiteral } from "@/lib/fiscal-kb/embed";

// ─────────────────────────────────────────────────────────────────────────────
// Dedupe en dos pases: similitud de título (barata, sin red) y coseno de
// embeddings vía pgvector (semántica). Ninguno auto-fusiona: sólo marcan
// `dedupeOf` y la tarjeta de Telegram ofrece "merge" — el humano decide.
// ─────────────────────────────────────────────────────────────────────────────

/** Umbral de coseno para proponer duplicado semántico. */
export const SEMANTIC_DUP_THRESHOLD = 0.85;
/** Umbral de Jaccard de tokens para el pase barato por título. */
export const TITLE_DUP_THRESHOLD = 0.6;

const STOPWORDS = new Set([
  "de", "del", "la", "el", "los", "las", "un", "una", "en", "por", "para",
  "con", "que", "y", "o", "a", "al", "se", "su", "sus", "no", "mi", "mis",
]);

/** Normaliza y tokeniza un título: minúsculas, sin acentos ni stopwords. */
export function titleTokens(title: string): Set<string> {
  const norm = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ");
  const tokens = new Set<string>();
  for (const t of norm.split(/\s+/)) {
    if (t.length >= 3 && !STOPWORDS.has(t)) tokens.add(t);
  }
  return tokens;
}

/**
 * ¿Dos tokens son "el mismo" a pesar de la flexión? Igualdad, o uno es prefijo
 * del otro con raíz ≥4 ("descarga"/"descargar", "factura"/"facturas") — un
 * stemming barato que basta para títulos cortos en español.
 */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [corto, largo] = a.length <= b.length ? [a, b] : [b, a];
  return corto.length >= 4 && largo.startsWith(corto);
}

/** Jaccard (con matching flexivo) sobre tokens normalizados — el pase "exact-ish" del spec. */
export function titleSimilarity(a: string, b: string): number {
  const ta = [...titleTokens(a)];
  const tb = [...titleTokens(b)];
  if (ta.length === 0 || tb.length === 0) return 0;
  const usados = new Set<number>();
  let inter = 0;
  for (const t of ta) {
    const idx = tb.findIndex((u, i) => !usados.has(i) && tokensMatch(t, u));
    if (idx >= 0) {
      usados.add(idx);
      inter++;
    }
  }
  return inter / (ta.length + tb.length - inter);
}

export function titlesLookDuplicate(a: string, b: string): boolean {
  return titleSimilarity(a, b) >= TITLE_DUP_THRESHOLD;
}

/**
 * Calcula y guarda el embedding del ask (título + cuerpo). Best-effort: si no
 * hay OPENAI_API_KEY devuelve null y el dedupe semántico simplemente no corre.
 */
export async function indexAskEmbedding(askId: string, text: string): Promise<number[] | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  const [embedding] = await embedTexts([text.slice(0, 8000)]);
  const vec = toVectorLiteral(embedding);
  await prisma.$executeRawUnsafe(
    `INSERT INTO "AskEmbedding" ("candidateAskId", "embedding") VALUES ($1, $2::vector)
     ON CONFLICT ("candidateAskId") DO UPDATE SET "embedding" = EXCLUDED."embedding"`,
    askId,
    vec
  );
  return embedding;
}

/**
 * Vecino más cercano entre los asks ABIERTOS del mismo producto (excluyendo el
 * propio). Devuelve el candidato si supera el umbral de coseno.
 */
export async function findSemanticDuplicate(
  askId: string,
  product: string | null,
  embedding: number[]
): Promise<{ id: string; similarity: number } | null> {
  const vec = toVectorLiteral(embedding);
  const rows = await prisma.$queryRawUnsafe<{ id: string; similarity: number }[]>(
    `SELECT a."id", 1 - (e."embedding" <=> $1::vector) AS "similarity"
       FROM "AskEmbedding" e
       JOIN "CandidateAsk" a ON a."id" = e."candidateAskId"
      WHERE a."id" <> $2
        AND a."status" IN ('PENDING', 'APPROVED', 'AUTO_APPROVED')
        AND ($3::text IS NULL OR a."product" = $3)
      ORDER BY e."embedding" <=> $1::vector
      LIMIT 1`,
    vec,
    askId,
    product
  );
  const best = rows[0];
  return best && best.similarity >= SEMANTIC_DUP_THRESHOLD ? best : null;
}
