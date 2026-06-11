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
import { ingestLey } from "../src/lib/fiscal-kb/orchestrate";

async function main() {
  const clave = (process.argv[2] ?? "LISR").toUpperCase();
  console.log(`→ Ingesta de ${clave} (descarga + chunk + embeddings + upsert versionado)…`);
  const r = await ingestLey(clave);
  if (r.skipped) {
    console.log("✓ Sin cambios desde la última ingesta (hash idéntico) — nada que hacer.");
    return;
  }
  console.log(
    `✓ ${r.clave}: ${r.chunkCount} chunks (${r.unidades} artículos), vigente desde ${r.vigenciaDesde}` +
      `${r.closedPreviousVersion ? " — versión anterior cerrada" : ""}`
  );
  console.log(`\nPrueba:  npm run fiscal:search -- "¿quién puede tributar en RESICO?"`);
}

main()
  .catch((e) => {
    console.error("✗", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
