// ─────────────────────────────────────────────────────────────────────────────
// Reglamentos federales vigentes desde el índice de la Cámara de Diputados
// (https://www.diputados.gob.mx/LeyesBiblio/regla.htm): ~150 reglamentos de
// leyes con su PDF, fecha original y última reforma. Mismo patrón que
// catalogo/diputados.ts (leyes). Puro; el script fiscal-catalogo-reglamentos
// escribe catalogo/reglamentos-federales.json.
// ─────────────────────────────────────────────────────────────────────────────

import { clasificarMaterias, type Materia } from "../materias";
import { DIPUTADOS_BASE, normalizarTitulo } from "./diputados";

export const DIPUTADOS_REGLAMENTOS_URL = `${DIPUTADOS_BASE}regla.htm`;

export interface FilaReglamento {
  numero: string;
  titulo: string;
  archivo: string; // "Reg_LOPSRM"
  urlPdf: string;
  dofOriginal: string | null;
  ultimaReforma: string | null;
}

export interface EntradaReglamento {
  clave: string; // "R-LOPSRM"
  titulo: string;
  url: string;
  archivo: string;
  dofOriginal: string | null;
  ultimaReforma: string | null;
  vigenciaFallback: string | null;
  materias: Materia[];
  excluida: string | null;
}

function ddmmyyyy(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

const ENTIDADES: Record<string, string> = { aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", uuml: "ü" };

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&(aacute|eacute|iacute|oacute|uacute|ntilde|Aacute|Eacute|Iacute|Oacute|Uacute|Ntilde|uuml);/g, (_, e: string) => ENTIDADES[e] ?? "");
}

/**
 * Filas del índice de reglamentos: «NN REGLAMENTO de la Ley … Original DOF
 * dd/mm/aaaa Reformas DOF dd/mm/aaaa, … PDF WORD» o «NN REGLAMENTO … dd/mm/aaaa
 * PDF WORD» (sin reformas). El PDF del texto vigente es el enlace regley/*.pdf
 * cuyo nombre NO lleva sufijo de decreto (_orig_, _ref, _cant).
 */
export function parsearIndiceReglamentos(html: string): FilaReglamento[] {
  const filas: FilaReglamento[] = [];
  for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const hrefs = [...tr.matchAll(/href="([^"]+)"/gi)].map((m) => m[1]);
    const pdfs = hrefs.filter((h) => /^(regley|regla)\/[^/]+\.pdf$/i.test(h) && !/_(orig|ref\d*|cant\d*|abro)[_.]/i.test(h));
    if (pdfs.length === 0) continue;
    const pdf = pdfs[0];
    const texto = decode(tr.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    const m = texto.match(/^(\d{2,3})\s+(REGLAMENTO.+?)\s+(?:Original\s+DOF\s+)?(\d{2}\/\d{2}\/\d{4})(.*)$/i);
    if (!m) continue;
    const [, numero, titulo, orig, resto] = m;
    // La fila repite la fecha original al final («Reforma DOF 06/05/2016
    // 08/10/2015 PDF»): la última reforma es la fecha MÁS RECIENTE del resto,
    // no la última escrita.
    const fechas = [...resto.matchAll(/(\d{2}\/\d{2}\/\d{4})/g)].map((x) => ddmmyyyy(x[1])!).filter((f) => f > (ddmmyyyy(orig) ?? ""));
    const ultima = fechas.length > 0 ? fechas.sort().at(-1)! : null;
    filas.push({
      numero,
      titulo: titulo.replace(/\s+/g, " ").trim(),
      archivo: pdf.replace(/^(regley|regla)\//, "").replace(/\.pdf$/i, ""),
      urlPdf: `${DIPUTADOS_BASE}${pdf}`,
      dofOriginal: ddmmyyyy(orig),
      ultimaReforma: ultima,
    });
  }
  return filas;
}

/** Los reglamentos que ya vivían en manuales.ts conservan su clave; el resto es «R-» + archivo sin «Reg_» ni fecha. */
export const CLAVE_REGLAMENTO_POR_ARCHIVO: Record<string, string> = {
  Reg_LISR_060516: "RLISR",
  Reg_LIVA_250914: "RLIVA",
  Reg_CFF: "RCFF",
  Reg_LSS_MACERF: "RACERF",
  Reg_LFPIORPI: "RLFPIORPI",
};

export function claveReglamento(archivo: string): string {
  const manual = CLAVE_REGLAMENTO_POR_ARCHIVO[archivo];
  if (manual) return manual;
  const base = archivo
    .replace(/^Reg_/i, "")
    .replace(/_(\d{6}|\d{4})$/, "")
    .replace(/_/g, "-")
    .toUpperCase();
  return `R-${base}`;
}

export function construirCatalogoReglamentos(filas: FilaReglamento[]): EntradaReglamento[] {
  const vistas = new Map<string, string>();
  const out: EntradaReglamento[] = [];
  for (const f of filas) {
    let clave = claveReglamento(f.archivo);
    // Dos reglamentos con el mismo archivo base (p. ej. una versión 2010 y la
    // vigente) se distinguen por el año del original; nunca se pisan.
    if (vistas.has(clave)) clave = `${clave}-${(f.dofOriginal ?? "0000").slice(0, 4)}`;
    if (vistas.has(clave)) throw new Error(`Clave duplicada «${clave}»: ${vistas.get(clave)} y ${f.archivo}`);
    vistas.set(clave, f.archivo);
    const titulo = normalizarTitulo(f.titulo);
    out.push({
      clave,
      titulo,
      url: f.urlPdf,
      archivo: f.archivo,
      dofOriginal: f.dofOriginal,
      ultimaReforma: f.ultimaReforma,
      vigenciaFallback: f.ultimaReforma ?? f.dofOriginal,
      materias: clasificarMaterias(clave, titulo),
      excluida: null,
    });
  }
  return out;
}
