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
import { DOCS, fetchDoc } from "../src/lib/fiscal-kb/ingest-docs";
import { chunkDocument } from "../src/lib/fiscal-kb/chunk";
import { upsertFiscalDocument } from "../src/lib/fiscal-kb/upsert";

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
  const vigenciaOverride = getFlag("vigencia");

  console.log(`→ Obteniendo ${clave}${file ? ` (archivo local: ${file})` : " (URL del SAT)"}…`);
  const { spec, rawText } = await fetchDoc(clave, { file });
  console.log(`✓ ${rawText.length.toLocaleString()} chars`);

  const chunks = chunkDocument(rawText, spec.kind);
  const unidades = new Set(chunks.map((c) => c.articulo ?? "—")).size;
  console.log(`✓ ${chunks.length} chunks (${unidades} ${spec.kind === "rmf" ? "reglas" : "secciones/unidades"})`);

  const vigenciaDesde = new Date(`${vigenciaOverride ?? spec.vigenciaDesde}T00:00:00Z`);

  console.log("→ Generando embeddings + upsert versionado…");
  const result = await upsertFiscalDocument({
    source: spec.source,
    clave: spec.clave,
    titulo: spec.titulo,
    url: file ? `file://${file}` : spec.url ?? "",
    publicadoDof: vigenciaDesde,
    vigenciaDesde,
    cleanText: rawText, // hashed for change detection
    chunks,
  });

  if (result.skipped) {
    console.log("✓ Sin cambios desde la última ingesta (hash idéntico).");
    return;
  }
  console.log(`✓ Documento ${result.documentId} con ${result.chunkCount} chunks${result.closedPreviousVersion ? " (versión anterior cerrada)" : ""}`);
  console.log(`\nPrueba:  npm run fiscal:search -- "¿cuándo se usa PUE y cuándo PPD?"`);
}

main()
  .catch((e) => {
    console.error("✗", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
