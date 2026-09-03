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
export async function ingestLey(
  clave: string,
  opts: { force?: boolean; vigencia?: string } = {}
): Promise<IngestResult> {
  const ley = await fetchLey(clave);
  // Un reglamento sin reformas no trae «Última reforma DOF» en el encabezado;
  // el job puede mandar la vigencia a mano (misma opción que los docs).
  const respaldo = opts.vigencia ?? ley.descriptor.vigenciaFallback;
  const vigencia = ley.ultimaReformaDof ?? (respaldo ? new Date(`${respaldo}T00:00:00Z`) : null);
  if (!vigencia) {
    throw new Error(
      `${clave}: no se detectó la fecha de última reforma — sin ella no hay versionado de vigencia. Manda {"vigencia":"YYYY-MM-DD"} en el job.`
    );
  }
  const clean = cleanLawText(ley.rawText);
  const chunks = chunkLaw(clean);
  const r = await upsertFiscalDocument({
    source: ley.descriptor.source ?? "LEY",
    clave: ley.descriptor.clave,
    titulo: ley.descriptor.titulo,
    url: ley.descriptor.url,
    publicadoDof: vigencia,
    vigenciaDesde: vigencia,
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
    vigenciaDesde: vigencia.toISOString().slice(0, 10),
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
