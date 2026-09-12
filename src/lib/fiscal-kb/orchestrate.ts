// Orchestration for fiscal KB ingestion — shared by the CLI scripts
// (scripts/fiscal-ingest-*.ts) and the admin HTTP route
// (api/admin/fiscal-ingest). Keeps "fetch → chunk → embed → versioned upsert"
// in one place so both entry points behave identically.
//
// Design doc: docs/FISCAL-KNOWLEDGE-BASE.md §6.

import { fetchLey, LEYES } from "./ingest-leyes";
import { fetchDoc } from "./ingest-docs";
import { cleanLawText, chunkLaw, chunkDocument } from "./chunk";
import { upsertFiscalDocument } from "./upsert";
import { prisma } from "../prisma";

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
  if (vigencia && Number.isNaN(vigencia.getTime())) {
    throw new Error(`${clave}: la fecha de vigencia «${respaldo}» no es una fecha — revisa el catálogo.`);
  }
  if (!vigencia) {
    throw new Error(
      `${clave}: no se detectó la fecha de última reforma — sin ella no hay versionado de vigencia. Manda {"vigencia":"YYYY-MM-DD"} en el job.`
    );
  }
  // Una NOM o unas NTC no van por artículos: se parten por secciones (kind "guia").
  const kind = ley.descriptor.kind ?? "ley";
  const clean = kind === "ley" ? cleanLawText(ley.rawText) : ley.rawText;
  const chunks = kind === "ley" ? chunkLaw(clean) : chunkDocument(ley.rawText, kind);
  const r = await upsertFiscalDocument({
    source: ley.descriptor.source ?? "LEY",
    clave: ley.descriptor.clave,
    titulo: ley.descriptor.titulo,
    url: ley.descriptor.url,
    publicadoDof: vigencia,
    vigenciaDesde: vigencia,
    cleanText: clean,
    chunks,
    materias: ley.descriptor.materias,
    ambito: ley.descriptor.ambito,
    entidad: ley.descriptor.entidad ?? null,
    municipio: ley.descriptor.municipio ?? null,
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
    materias: spec.materias ?? ["fiscal"],
    ambito: "FEDERAL",
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

// ── Catálogo completo por lotes ──────────────────────────────────────────────

export interface CatalogoLoteOpts {
  /** Índice (en CLAVES ordenadas) desde el que se procesa. */
  offset?: number;
  /** Segundos de trabajo antes de devolver el control (la request de Railway muere a los 300). */
  presupuestoSegundos?: number;
  /** Sólo claves sin NINGUNA versión en la base: la carga inicial, reanudable y sin descargar lo ya cargado. */
  soloFaltantes?: boolean;
  force?: boolean;
}

export interface CatalogoLoteResult {
  /** Claves del catálogo, en el orden que recorre el lote. */
  total: number;
  procesadas: number;
  ingeridas: number;
  sinCambios: number;
  fallidas: number;
  /** Desde dónde sigue el siguiente lote; null = terminó. */
  siguiente: number | null;
  restantes: number;
  ms: number;
  resultados: (IngestResult & { ok: boolean; error?: string })[];
}

/** Claves del catálogo en orden estable (alfabético) para recorrerlo por lotes. */
export function clavesCatalogo(): string[] {
  return Object.keys(LEYES).sort();
}

/**
 * Recorre el catálogo por lotes con presupuesto de tiempo: la ingesta de una
 * ley nueva tarda 10–40 s (descarga + embeddings) y hay 300+; el workflow
 * repite la llamada con `siguiente` hasta que devuelva null. Idempotente:
 * lo que no cambió se salta por hash.
 */
export async function ingestCatalogoLote(opts: CatalogoLoteOpts = {}): Promise<CatalogoLoteResult> {
  const inicio = Date.now();
  const presupuesto = Math.max(30, Math.min(opts.presupuestoSegundos ?? 200, 270)) * 1000;
  const claves = clavesCatalogo();
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));

  let existentes = new Set<string>();
  if (opts.soloFaltantes) {
    const rows = await prisma.fiscalDocument.findMany({ select: { clave: true }, distinct: ["clave"] });
    existentes = new Set(rows.map((r) => r.clave));
  }

  const resultados: CatalogoLoteResult["resultados"] = [];
  let i = offset;
  let ingeridas = 0;
  let sinCambios = 0;
  let fallidas = 0;
  for (; i < claves.length; i++) {
    if (Date.now() - inicio > presupuesto) break;
    const clave = claves[i];
    if (opts.soloFaltantes && existentes.has(clave)) continue;
    try {
      const r = await ingestLey(clave, { force: opts.force });
      resultados.push({ ...r, ok: true });
      if (r.skipped) sinCambios++;
      else ingeridas++;
    } catch (err) {
      fallidas++;
      resultados.push({ clave, skipped: false, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const siguiente = i < claves.length ? i : null;
  return {
    total: claves.length,
    procesadas: resultados.length,
    ingeridas,
    sinCambios,
    fallidas,
    siguiente,
    restantes: siguiente === null ? 0 : claves.length - siguiente,
    ms: Date.now() - inicio,
    resultados,
  };
}
