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
import type { Materia } from "./materias";
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
  /** Materias (ver materias.ts). Default: ["fiscal"] — todos los docs del SAT lo son. */
  materias?: Materia[];
}

/**
 * Catálogo de documentos SAT. URLs are best-effort — if one 404s, download the
 * PDF from the SAT portal manually and pass `--file <path>`. Dates are the
 * known publication of the current version; refine as needed.
 */
const SAT_NORMATIVIDAD = "https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE";

export const DOCS: Record<string, DocSpec> = {
  // La guía PRINCIPAL del CFDI 4.0 (atributo por atributo: Fecha, FormaPago,
  // MetodoPago PUE/PPD, UsoCFDI…). Faltaba: el copiloto sólo tenía la de pagos
  // y la global.
  "GUIA-CFDI": {
    clave: "GUIA-CFDI",
    titulo: "Anexo 20 — Guía de llenado de los comprobantes fiscales digitales por Internet (CFDI 4.0)",
    source: "GUIA",
    kind: "guia",
    url: "http://omawww.sat.gob.mx/tramitesyservicios/Paginas/documentos/Anexo_20_Guia_de_llenado_CFDI.pdf",
    vigenciaDesde: "2022-01-01",
  },
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
  "GUIA-NOMINA": {
    clave: "GUIA-NOMINA",
    titulo: "Guía de llenado del CFDI de nómina 4.0 y su complemento 1.2",
    source: "GUIA",
    kind: "guia",
    url: "http://omawww.sat.gob.mx/tramitesyservicios/Paginas/documentos/Guia_llenado_nomina.pdf",
    vigenciaDesde: "2026-01-16",
  },
  // RMF anual. El DOF bloquea bots, pero el micrositio de normatividad del SAT
  // sirve los PDF (oficial y compilados).
  "RMF-2026": {
    clave: "RMF-2026",
    titulo: "Resolución Miscelánea Fiscal para 2026",
    source: "RMF",
    kind: "rmf",
    url: `${SAT_NORMATIVIDAD}/documentos2026/rmf/rmf/RMF_2026-DOF-28122025.pdf`,
    vigenciaDesde: "2026-01-01",
  },
  // La MISMA clave, versión nueva: el compilado oficial del SAT con la Primera
  // Modificación (DOF 17-jul-2026). Al ingerirla, upsert cierra la versión de
  // enero el día anterior: una pregunta de marzo sigue leyendo el texto de marzo.
  "RMF-2026-1M": {
    clave: "RMF-2026",
    titulo: "Resolución Miscelánea Fiscal para 2026 (compilada con la Primera Modificación)",
    source: "RMF",
    kind: "rmf",
    url: `${SAT_NORMATIVIDAD}/documentos2026/rmf/compiladas/Compilado_Primera_Modificacion_a_la-Resolucion_Miscelanea_Fiscal_para_2026.pdf`,
    vigenciaDesde: "2026-07-17",
  },
  // Criterios del SAT: cómo interpreta la ley (normativos, Anexo 7) y qué
  // considera práctica indebida (no vinculativos, Anexo 3).
  "RMF-2026-A7": {
    clave: "RMF-2026-A7",
    titulo: "Anexo 7 de la RMF 2026 — Criterios normativos del SAT",
    source: "CRITERIO",
    kind: "criterio",
    url: `${SAT_NORMATIVIDAD}/documentos2026/rmf/anexos/Anexo_7_RMF2026-09012026.pdf`,
    vigenciaDesde: "2026-01-09",
  },
  "RMF-2026-A3": {
    clave: "RMF-2026-A3",
    titulo: "Anexo 3 de la RMF 2026 — Criterios no vinculativos (prácticas fiscales indebidas), compilado con la Primera Modificación",
    source: "CRITERIO",
    kind: "criterio",
    url: `${SAT_NORMATIVIDAD}/documentos2026/rmf/compiladas/Compilado_PrimeraModificacion_Anexo3_RMF2026-17072026.pdf`,
    vigenciaDesde: "2026-01-09",
  },
  "RFA-2026": {
    clave: "RFA-2026",
    titulo: "Resolución de Facilidades Administrativas para 2026 (AGAPES, autotransporte)",
    source: "DOF",
    kind: "rmf",
    url: `${SAT_NORMATIVIDAD}/documentos2026/rfa/rfa/RFA2026_17022026.pdf`,
    vigenciaDesde: "2026-02-17",
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
