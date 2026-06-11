// Orchestration for fiscal KB ingestion — shared by the CLI scripts
// (scripts/fiscal-ingest-*.ts) and the admin HTTP route
// (api/admin/fiscal-ingest). Keeps "fetch → chunk → embed → versioned upsert"
// in one place so both entry points behave identically.
//
// Design doc: docs/FISCAL-KNOWLEDGE-BASE.md §6.

import { fetchLey } from "./ingest-leyes";
import { fetchDoc } from "./ingest-docs";
import { cleanLawText, chunkLaw, chunkDocument } from "./chunk";
import { upsertFiscalDocument } from "./upsert";

export interface IngestResult {
  clave: string;
  skipped: boolean;
  chunkCount?: number;
  unidades?: number; // distinct artículos / reglas / secciones
  closedPreviousVersion?: boolean;
  vigenciaDesde?: string;
}

/** Ingest a ley vigente (Cámara de Diputados) by catalog clave. */
export async function ingestLey(clave: string, opts: { force?: boolean } = {}): Promise<IngestResult> {
  const ley = await fetchLey(clave);
  if (!ley.ultimaReformaDof) {
    throw new Error(`${clave}: no se detectó la fecha de última reforma — sin ella no hay versionado de vigencia.`);
  }
  const clean = cleanLawText(ley.rawText);
  const chunks = chunkLaw(clean);
  const r = await upsertFiscalDocument({
    source: "LEY",
    clave: ley.descriptor.clave,
    titulo: ley.descriptor.titulo,
    url: ley.descriptor.url,
    publicadoDof: ley.ultimaReformaDof,
    vigenciaDesde: ley.ultimaReformaDof,
    cleanText: clean,
    chunks,
    force: opts.force,
  });
  return {
    clave: ley.descriptor.clave,
    skipped: r.skipped,
    chunkCount: r.chunkCount,
    unidades: new Set(chunks.map((c) => c.articulo)).size,
    closedPreviousVersion: r.closedPreviousVersion,
    vigenciaDesde: ley.ultimaReformaDof.toISOString().slice(0, 10),
  };
}

/** Ingest a SAT/DOF document (RMF / guía) by catalog clave. */
export async function ingestDoc(clave: string, opts: { file?: string; vigencia?: string; force?: boolean } = {}): Promise<IngestResult> {
  const { spec, rawText } = await fetchDoc(clave, { file: opts.file });
  const chunks = chunkDocument(rawText, spec.kind);
  const vigenciaDesde = new Date(`${opts.vigencia ?? spec.vigenciaDesde}T00:00:00Z`);
  const r = await upsertFiscalDocument({
    source: spec.source,
    clave: spec.clave,
    titulo: spec.titulo,
    url: opts.file ? `file://${opts.file}` : spec.url ?? "",
    publicadoDof: vigenciaDesde,
    vigenciaDesde,
    cleanText: rawText,
    chunks,
    force: opts.force,
  });
  return {
    clave: spec.clave,
    skipped: r.skipped,
    chunkCount: r.chunkCount,
    unidades: new Set(chunks.map((c) => c.articulo ?? "—")).size,
    closedPreviousVersion: r.closedPreviousVersion,
    vigenciaDesde: vigenciaDesde.toISOString().slice(0, 10),
  };
}
