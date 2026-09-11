// Fetch + parse leyes vigentes (texto vigente en PDF, dominio público):
// federales desde la Cámara de Diputados, estatales desde cada congreso.
// Extrae la fecha de «Última reforma publicada DOF» como vigencia/publicación
// de la versión.
//
// Phase-0 caveat (documented in docs/FISCAL-KNOWLEDGE-BASE.md §4): we use the
// DOF publication date of the latest reform as `vigenciaDesde`. Strictly,
// entry into force is governed by each decreto's transitorios — good enough
// to version texts; refine in Phase 2.
//
// El catálogo (docs/MOTOR-JURIDICO.md §5.2) ya no es una lista a mano: los
// 317 ordenamientos federales vienen de catalogo/federal.json, generado desde
// el índice de Diputados por `npm run fiscal:catalogo` y revisado por PR;
// encima van las entradas manuales (reglamentos, estatales, correcciones) de
// catalogo/manuales.ts. Cada entrada trae `materias` y `ambito`: con eso el
// hub busca sólo lo que un contador cita y el producto legal busca todo.

import federal from "./catalogo/federal.json";
import { LEYES_MANUALES } from "./catalogo/manuales";
import type { Ambito, Materia } from "./materias";

export interface LeyDescriptor {
  clave: string;
  titulo: string;
  url: string;
  /** LEY (default) o REGLAMENTO — decide la cita: «Art. 3 RLIVA». */
  source?: "LEY" | "REGLAMENTO";
  /**
   * Vigencia de respaldo (YYYY-MM-DD) para una fuente cuyo encabezado NO trae
   * «Última reforma DOF» — un texto que nunca ha sido reformado sólo dice
   * «Nuevo Reglamento publicado en el DOF el …». Se usa únicamente cuando el
   * encabezado no da fecha; si algún día lo reforman, la del encabezado gana.
   */
  vigenciaFallback?: string;
  /** Materias del ordenamiento (ver materias.ts). Nunca vacío. */
  materias: Materia[];
  ambito: Ambito;
  /** Entidad federativa (clave SAT de 3 letras: PUE, CMX) cuando ambito = ESTATAL. */
  entidad?: string;
  /** Página de reformas en Diputados (historia de decretos). */
  urlRef?: string | null;
}

interface EntradaFederal {
  clave: string;
  titulo: string;
  url: string;
  urlRef: string | null;
  vigenciaFallback: string | null;
  materias: string[];
  excluida: string | null;
}

const ENTRADAS = (federal as { entradas: EntradaFederal[] }).entradas;

function construirCatalogo(): Record<string, LeyDescriptor> {
  const out: Record<string, LeyDescriptor> = {};
  for (const e of ENTRADAS) {
    if (e.excluida) continue;
    out[e.clave] = {
      clave: e.clave,
      titulo: e.titulo,
      url: e.url,
      urlRef: e.urlRef,
      vigenciaFallback: e.vigenciaFallback ?? undefined,
      materias: e.materias as Materia[],
      ambito: "FEDERAL",
    };
  }
  for (const [clave, d] of Object.entries(LEYES_MANUALES)) out[clave] = { ...out[clave], ...d };
  return out;
}

/** Catálogo completo: federal generado + manuales encima. */
export const LEYES: Record<string, LeyDescriptor> = construirCatalogo();

/** Ordenamientos del índice federal que no se ingieren, con el motivo. */
export const LEYES_EXCLUIDAS: { clave: string; titulo: string; motivo: string }[] = ENTRADAS.filter((e) => e.excluida).map((e) => ({
  clave: e.clave,
  titulo: e.titulo,
  motivo: e.excluida as string,
}));

/**
 * Claves conocidas, de la más larga a la más corta: así una alternancia de
 * regex prueba «RLISR» antes que «LISR» y «LFPIORPI» antes que «LFPC».
 */
export const CLAVES_LEYES: readonly string[] = Object.keys(LEYES).sort((a, b) => b.length - a.length || a.localeCompare(b));

/** Alternancia lista para una regex: claves del catálogo + RMF, escapadas. */
export function alternanciaClaves(): string {
  return [...CLAVES_LEYES, "RMF"].map((c) => c.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")).join("|");
}

/** Claves cuyo ordenamiento toca alguna de las materias dadas. */
export function clavesPorMateria(materias: readonly string[]): string[] {
  return Object.values(LEYES)
    .filter((d) => d.materias.some((m) => materias.includes(m)))
    .map((d) => d.clave)
    .sort();
}

export interface FetchedLey {
  descriptor: LeyDescriptor;
  rawText: string;
  /** DOF date of the latest reform found in the document header. */
  ultimaReformaDof: Date | null;
}

const MESES: Record<string, number> = {
  enero: 1, ene: 1, febrero: 2, feb: 2, marzo: 3, mar: 3, abril: 4, abr: 4, mayo: 5, may: 5, junio: 6, jun: 6,
  julio: 7, jul: 7, agosto: 8, ago: 8, septiembre: 9, sep: 9, set: 9, octubre: 10, oct: 10, noviembre: 11, nov: 11, diciembre: 12, dic: 12,
};
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

/**
 * Fecha de la última reforma según el formato de cada editor. Puro.
 *  - Diputados: «Última reforma publicada DOF 01-04-2024» / «Última Reforma DOF …».
 *  - Consejería / Congreso CDMX: «Última reforma publicada en la G.O.C.D.M.X. el 19 de diciembre de 2025».
 *  - Orden Jurídico Poblano: tabla «REFORMAS» con fechas «5/ago/2024» — se toma la mayor.
 *  - Facsímil del DOF (reglamentos viejos): «(Primera Sección) DIARIO OFICIAL Viernes 10 de febrero de 2012».
 */
export function parseFechaVigencia(text: string): Date | null {
  const dof = text.match(/Última reforma(?: publicada)? DOF (\d{2})-(\d{2})-(\d{4})/i);
  if (dof) return utc(Number(dof[3]), Number(dof[2]), Number(dof[1]));
  const go = text.match(/Última reforma publicada en la G\.?\s?O\.?\s?C\.?\s?D\.?\s?M\.?\s?X\.?\s+el\s+(\d{1,2})\s+de\s+([a-záéíóú]+)\s+(?:de\s+)?(\d{4})/i);
  if (go && MESES[go[2].toLowerCase()]) return utc(Number(go[3]), MESES[go[2].toLowerCase()], Number(go[1]));
  if (/Orden Jurídico Poblano/.test(text.slice(0, 2000))) {
    let mejor: Date | null = null;
    for (const m of text.slice(0, 40_000).matchAll(/\b(\d{1,2})\/([a-z]{3})\/(\d{4})\b/gi)) {
      const mes = MESES[m[2].toLowerCase()];
      if (!mes) continue;
      const d = utc(Number(m[3]), mes, Number(m[1]));
      if (!mejor || d > mejor) mejor = d;
    }
    if (mejor) return mejor;
  }
  const print = text.slice(0, 800).match(/DIARIO OFICIAL\s+(?:Lunes|Martes|Miércoles|Jueves|Viernes|Sábado|Domingo)\s+(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i);
  if (print && MESES[print[2].toLowerCase()]) return utc(Number(print[3]), MESES[print[2].toLowerCase()], Number(print[1]));
  return null;
}

/**
 * Texto mínimo para dar por buena una descarga. Las leyes de una página
 * existen (Ley de Amnistía de 1994, leyes reglamentarias de una fracción):
 * el umbral sólo detecta un PDF vacío o una página de error servida como PDF.
 */
const TEXTO_MINIMO = 1_500;

export async function fetchLey(clave: string): Promise<FetchedLey> {
  const descriptor = LEYES[clave];
  if (!descriptor) {
    const excluida = LEYES_EXCLUIDAS.find((e) => e.clave === clave);
    if (excluida) throw new Error(`Ley ${clave} excluida del catálogo: ${excluida.motivo}`);
    throw new Error(`Ley desconocida: ${clave}. El catálogo tiene ${CLAVES_LEYES.length} claves (ver catalogo/federal.json y catalogo/manuales.ts).`);
  }
  const res = await fetch(descriptor.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; contabilidad-os/fiscal-kb)", Accept: "application/pdf,*/*" } });
  if (!res.ok) throw new Error(`Descarga falló (${res.status}) — ${descriptor.url}`);
  const buffer = new Uint8Array(await res.arrayBuffer());

  // pdf-parse v2 exposes a class API; @types/pdf-parse targets v1, so we
  // require() and type the surface we use. Lazy require INSIDE the function:
  // pdf-parse → pdfjs touches DOMMatrix at load time and breaks Next.js'
  // build-time page-data collection if imported at module scope.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PDFParse } = require("pdf-parse") as {
    PDFParse: new (opts: { data: Uint8Array }) => { getText(): Promise<{ text: string }> };
  };
  const parser = new PDFParse({ data: buffer });
  const { text } = await parser.getText();
  if (!text || text.length < TEXTO_MINIMO) {
    throw new Error(`PDF de ${clave} produjo texto sospechosamente corto (${text?.length ?? 0} chars)`);
  }
  return { descriptor, rawText: text, ultimaReformaDof: parseFechaVigencia(text) };
}
