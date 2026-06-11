/**
 * Ingest a SAT/DOF document (RMF or guía de llenado / Anexo 20) into the
 * fiscal knowledge base: fetch (URL or local file) → chunk by kind → embed →
 * versioned upsert. Idempotent (hash-skip). Complements fiscal:ingest-ley,
 * which handles the Cámara de Diputados law PDFs.
 *
 * Usage (requires DATABASE_URL + OPENAI_API_KEY):
 *   npm run fiscal:ingest-doc GUIA-PAGOS                     # from SAT URL
 *   npm run fiscal:ingest-doc RMF-2026 -- --file ./rmf.pdf   # local PDF (DOF blocks bots)
 *   npm run fiscal:ingest-doc GUIA-PAGOS -- --vigencia 2024-01-01
 *
 * Catalog of claves: see DOCS in src/lib/fiscal-kb/ingest-docs.ts
 * Prerequisites: npm run fiscal:setup  →  npm run db:push
 */
import { prisma } from "../src/lib/prisma";
import { DOCS } from "../src/lib/fiscal-kb/ingest-docs";
import { ingestDoc } from "../src/lib/fiscal-kb/orchestrate";

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const clave = process.argv[2]?.toUpperCase();
  if (!clave || !DOCS[clave]) {
    console.error(`Uso: npm run fiscal:ingest-doc <CLAVE> [-- --file ruta.pdf] [--vigencia YYYY-MM-DD]`);
    console.error(`Claves disponibles: ${Object.keys(DOCS).join(", ")}`);
    process.exit(1);
  }

  const file = getFlag("file");
  const vigencia = getFlag("vigencia");
  const force = process.argv.includes("--force");
  console.log(`→ Ingesta de ${clave}${file ? ` (archivo local: ${file})` : " (URL del SAT)"}${force ? " [force]" : ""}…`);

  const r = await ingestDoc(clave, { file, vigencia, force });
  if (r.skipped) {
    console.log("✓ Sin cambios desde la última ingesta (hash idéntico).");
    return;
  }
  console.log(
    `✓ ${r.clave}: ${r.chunkCount} chunks (${r.unidades} unidades), vigente desde ${r.vigenciaDesde}` +
      `${r.closedPreviousVersion ? " — versión anterior cerrada" : ""}`
  );
  console.log(`\nPrueba:  npm run fiscal:search -- "¿cuándo se usa PUE y cuándo PPD?"`);
}

main()
  .catch((e) => {
    console.error("✗", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
