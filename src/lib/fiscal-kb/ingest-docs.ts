// Generic ingestion for SAT/DOF fiscal documents beyond the Cámara de
// Diputados leyes: RMF (reglas) and guías de llenado (Anexo 20).
//
// Reality of these sources (probed June 2026): SAT's omawww server serves some
// guías but renames/relocates them often (frequent 404s), and the DOF blocks
// automated requests (503). So every doc can be ingested from a URL *or* from
// a local file you downloaded by hand — the chunk/embed/upsert path is the same.
//
// Design doc: docs/FISCAL-KNOWLEDGE-BASE.md §3, §6 (Phase 3).

import { readFile } from "fs/promises";
import { FiscalSource } from "@prisma/client";
import { DocKind } from "./chunk";
import { parsePdfBuffer } from "./pdf";

export interface DocSpec {
  clave: string; // stable key, e.g. "GUIA-PAGOS", "RMF-2026"
  titulo: string;
  source: FiscalSource; // GUIA | RMF | CRITERIO | …
  kind: DocKind; // chunking strategy
  url?: string; // best-known URL; may 404 → use --file
  /** Publication / effective date. Guías rarely carry a parseable one, so the
   *  catalog pins a known date; override per-run with --vigencia. */
  vigenciaDesde: string; // ISO YYYY-MM-DD
}

/**
 * Catálogo de documentos SAT. URLs are best-effort — if one 404s, download the
 * PDF from the SAT portal manually and pass `--file <path>`. Dates are the
 * known publication of the current version; refine as needed.
 */
export const DOCS: Record<string, DocSpec> = {
  "GUIA-PAGOS": {
    clave: "GUIA-PAGOS",
    titulo: "Guía de llenado del CFDI con complemento para recepción de pagos (Anexo 20)",
    source: "GUIA",
    kind: "guia",
    url: "http://omawww.sat.gob.mx/tramitesyservicios/Paginas/documentos/Guia_llenado_pagos.pdf",
    vigenciaDesde: "2022-01-01", // CFDI 4.0 vigente; refine to exact revisión if needed
  },
  "GUIA-CFDI-GLOBAL": {
    clave: "GUIA-CFDI-GLOBAL",
    titulo: "Guía de llenado del CFDI global versión 4.0 (público en general)",
    source: "GUIA",
    kind: "guia",
    url: "http://omawww.sat.gob.mx/tramitesyservicios/Paginas/documentos/Guia_llenado_CFDI_global.pdf",
    vigenciaDesde: "2022-01-01",
  },
  // RMF anual — DOF/SAT bloquean descarga automática; usa --file con el PDF.
  "RMF-2026": {
    clave: "RMF-2026",
    titulo: "Resolución Miscelánea Fiscal para 2026",
    source: "RMF",
    kind: "rmf",
    vigenciaDesde: "2026-01-01",
  },
};

export interface FetchedDoc {
  spec: DocSpec;
  rawText: string;
}

/**
 * Resolve a doc's text from a local file (preferred when given) or its URL.
 * @param claveOrSpec catalog key or an ad-hoc DocSpec
 * @param opts.file   local PDF path — bypasses the URL (for DOF/rotated docs)
 */
export async function fetchDoc(claveOrSpec: string | DocSpec, opts: { file?: string } = {}): Promise<FetchedDoc> {
  const spec = typeof claveOrSpec === "string" ? DOCS[claveOrSpec] : claveOrSpec;
  if (!spec) {
    throw new Error(`Documento desconocido: ${claveOrSpec}. Disponibles: ${Object.keys(DOCS).join(", ")}`);
  }

  let buffer: Uint8Array;
  if (opts.file) {
    buffer = new Uint8Array(await readFile(opts.file));
  } else if (spec.url) {
    const res = await fetch(spec.url);
    if (!res.ok) {
      throw new Error(
        `Descarga falló (${res.status}) — ${spec.url}\n` +
          `La URL del SAT pudo cambiar. Descarga el PDF a mano y reintenta con:  --file <ruta.pdf>`
      );
    }
    buffer = new Uint8Array(await res.arrayBuffer());
  } else {
    throw new Error(`${spec.clave} no tiene URL (fuente bloquea bots). Descárgalo y pásalo con --file <ruta.pdf>`);
  }

  return { spec, rawText: await parsePdfBuffer(buffer, spec.clave) };
}
