/**
 * Ingest a ley fiscal (texto vigente, Cámara de Diputados) into the fiscal
 * knowledge base: download → parse → chunk by artículo → embed → versioned
 * upsert (vigencia-aware). Idempotent: unchanged content (same hash) is
 * skipped; changed content closes the prior version and inserts a new one.
 *
 * Usage (requires DATABASE_URL + OPENAI_API_KEY):
 *   npm run fiscal:ingest-ley            # default: LISR
 *   npm run fiscal:ingest-ley -- LIVA    # or: LISR | LIVA | CFF | LIEPS
 *
 * Prerequisites: npm run fiscal:setup  →  npm run db:push
 */
import { prisma } from "../src/lib/prisma";
import { fetchLey, LEYES } from "../src/lib/fiscal-kb/ingest-leyes";
import { cleanLawText, chunkLaw } from "../src/lib/fiscal-kb/chunk";
import { upsertFiscalDocument } from "../src/lib/fiscal-kb/upsert";

async function ensureIndex() {
  // HNSW is the better index; older pgvector (<0.5) only has ivfflat. Search
  // works without either (seq scan) — fine at one-law scale, so just warn.
  try {
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "FiscalChunk_embedding_hnsw" ON "FiscalChunk" USING hnsw ("embedding" vector_cosine_ops)`
    );
    console.log("✓ índice HNSW listo");
  } catch {
    console.warn("⚠ no se pudo crear índice HNSW (¿pgvector < 0.5?) — la búsqueda funciona, solo más lenta a escala");
  }
}

async function main() {
  const clave = (process.argv[2] ?? "LISR").toUpperCase();

  console.log(`→ Descargando ${clave} (${LEYES[clave]?.url ?? "clave desconocida"})…`);
  const ley = await fetchLey(clave);
  console.log(`✓ ${ley.rawText.length.toLocaleString()} chars; última reforma DOF: ${ley.ultimaReformaDof?.toISOString().slice(0, 10) ?? "no detectada"}`);

  const clean = cleanLawText(ley.rawText);
  const chunks = chunkLaw(clean);
  const articles = new Set(chunks.map((c) => c.articulo)).size;
  console.log(`✓ ${chunks.length} chunks (${articles} artículos/unidades)`);

  if (!ley.ultimaReformaDof) {
    throw new Error("No se detectó la fecha de última reforma — sin ella no hay versionado de vigencia. Revisa el PDF.");
  }

  console.log("→ Generando embeddings + upsert versionado…");
  const result = await upsertFiscalDocument({
    source: "LEY",
    clave: ley.descriptor.clave,
    titulo: ley.descriptor.titulo,
    url: ley.descriptor.url,
    publicadoDof: ley.ultimaReformaDof,
    vigenciaDesde: ley.ultimaReformaDof,
    cleanText: clean,
    chunks,
  });

  if (result.skipped) {
    console.log("✓ Sin cambios desde la última ingesta (hash idéntico) — nada que hacer.");
    return;
  }
  console.log(`✓ Documento ${result.documentId} con ${result.chunkCount} chunks${result.closedPreviousVersion ? " (versión anterior cerrada)" : ""}`);
  await ensureIndex();
  console.log(`\nPrueba:  npm run fiscal:search -- "¿quién puede tributar en RESICO?"`);
}

main()
  .catch((e) => {
    console.error("✗", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
