// ─────────────────────────────────────────────────────────────────────────────
// Normas Oficiales Mexicanas desde el Catálogo Mexicano de Normas (PLATIICA,
// Secretaría de Economía): un sitio WordPress con REST público. Cada NOM es
// un post con una ficha («Clave de la Norma», «Estado de la Norma: Vigente»,
// «Fecha de publicación en el DOF», «Dependencia(s)») y, casi siempre, el PDF
// del texto en /wp-content/uploads/sites/2/PDF_Normas_Publicas/. Los enlaces
// del sitio apuntan a una IP interna (10.100.20.231): se reescriben al host
// público. Parsers puros; el script fiscal-catalogo-nom.ts enumera y escribe
// catalogo/nom.json.
// ─────────────────────────────────────────────────────────────────────────────

import type { Materia } from "../materias";

export const PLATIICA_HOST = "https://platiica.economia.gob.mx";
export const PLATIICA_REST = `${PLATIICA_HOST}/normalizacion/wp-json/wp/v2`;

export interface EntradaNom {
  clave: string; // "NOM-001-SEDE-2012"
  titulo: string;
  estado: string | null; // "Vigente" | "Cancelada" | …
  fechaDof: string | null; // YYYY-MM-DD
  entradaEnVigor: string | null;
  dependencias: string[];
  url: string | null; // PDF del texto (host público) o null
  urlFicha: string;
  materias: Materia[];
  excluida: string | null;
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#8211;/g, "–")
    .replace(/&#8217;/g, "’")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function hostPublico(url: string): string {
  return url.replace(/^https?:\/\/10\.100\.20\.231/, PLATIICA_HOST);
}

function fechaDdMmYyyy(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}

/**
 * Dependencia (siglas dentro de la clave) → materias. La clave dice quién
 * la emitió: SEDE (energía eléctrica), ENER (eficiencia energética), STPS
 * (seguridad laboral), CONAGUA/CNA (agua), SEMARNAT (ambiente), SEDATU
 * (urbano), SCT (transporte), SSA (salud), SE/SCFI (comercio), ASEA
 * (hidrocarburos), SESH…
 */
const MATERIA_POR_SIGLAS: Record<string, Materia[]> = {
  SEDE: ["construccion", "energia"],
  ENER: ["construccion", "energia"],
  STPS: ["laboral", "construccion"],
  CONAGUA: ["construccion", "ambiental"],
  CNA: ["construccion", "ambiental"],
  SEMARNAT: ["ambiental"],
  ECOL: ["ambiental"],
  SEDATU: ["urbano", "construccion"],
  SEDESOL: ["urbano"],
  SCT: ["transporte"],
  SCT2: ["transporte", "construccion"],
  SCT3: ["transporte"],
  SSA1: ["salud"],
  SSA2: ["salud"],
  SSA3: ["salud"],
  SE: ["consumidor", "mercantil"],
  SCFI: ["consumidor", "mercantil"],
  ASEA: ["energia", "ambiental"],
  SESH: ["energia"],
  SECRE: ["energia"],
  SAGARPA: ["agrario"],
  SADER: ["agrario"],
  FITO: ["agrario"],
  ZOO: ["agrario"],
  SEGOB: ["seguridad_publica"],
  PESC: ["agrario", "ambiental"],
};

const RE_CONSTRUCCION = /construcci|edificaci|estructur|instalaci[óo]n(?:es)? el[ée]ctric|instalaci[óo]n(?:es)? hidr|instalaci[óo]n(?:es)? de gas|ciment|excavaci|andamio|obra|vivienda|aislamiento t[ée]rmico|envolvente|eficiencia energ[ée]tica.*edific|elevador|escalera|extintor|se[ñn]alizaci[óo]n|protecci[óo]n contra incendio|concreto|acero|cemento|ladrillo|tuber[íi]a|alcantarillado|agua potable|drenaje|puente|pavimento|carretera|sismo|accesibilidad/i;

export function siglasDe(clave: string): string | null {
  const m = clave.match(/^(?:NOM|PROY-NOM|NMX)-\d{3}[A-Z]?-([A-Z0-9]+)-\d{4}$/i);
  return m ? m[1].toUpperCase() : null;
}

export function materiasDeNom(clave: string, titulo: string): Materia[] {
  const out: Materia[] = [];
  const add = (ms: Materia[]) => {
    for (const m of ms) if (!out.includes(m)) out.push(m);
  };
  const s = siglasDe(clave);
  if (s && MATERIA_POR_SIGLAS[s]) add(MATERIA_POR_SIGLAS[s]);
  if (RE_CONSTRUCCION.test(titulo)) add(["construccion"]);
  return out.length > 0 ? out : ["administrativo"];
}

/** ¿Es una NOM que un constructor tiene que cumplir? (dependencia técnica o título de obra) */
export function esNomConstruccion(clave: string, titulo: string): boolean {
  const s = siglasDe(clave);
  return ["SEDE", "ENER", "CONAGUA", "CNA", "SEDATU"].includes(s ?? "") || (s === "STPS" && /obra|construcci|andamio|excavaci|altura|edific|electric|maquinaria|se[ñn]al|extintor|incendio/i.test(titulo)) || RE_CONSTRUCCION.test(titulo);
}

/** Ficha de un post del catálogo (HTML renderizado) → entrada. Devuelve null si no es una NOM con clave. */
export function parsearFichaNom(tituloPost: string, contenidoHtml: string, urlFicha: string): EntradaNom | null {
  const texto = decode(contenidoHtml.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  const claveM = texto.match(/Clave de la Norma:\s*([A-Z0-9-]+)/i) ?? tituloPost.match(/((?:NOM|PROY-NOM)-\d{3}[A-Z]?-[A-Z0-9]+-\d{4})/i);
  const clave = claveM?.[1]?.toUpperCase();
  if (!clave || !/^NOM-/.test(clave)) return null;
  const titulo = (texto.match(/T[íi]tulo de la Norma:\s*(.+?)\s+Estado de la Norma:/i)?.[1] ?? decode(tituloPost)).trim();
  const estado = texto.match(/Estado de la Norma:\s*([A-Za-zÁÉÍÓÚáéíóú ]+?)\s+Fecha/i)?.[1]?.trim() ?? null;
  const fechaDof = fechaDdMmYyyy(texto.match(/Fecha de publicaci[óo]n en el DOF:\s*([\d/]+)/i)?.[1]);
  const vigor = fechaDdMmYyyy(texto.match(/Fecha de entrada en vigor:\s*([\d/]+)/i)?.[1]);
  const deps = texto.match(/Dependencia\(s\):\s*(.+?)\s+(?:Comit[ée]|Concordancia|Enlace|Informaci[óo]n|$)/i)?.[1]?.split(/\s*[,;]\s*|\s+y\s+/).map((d) => d.trim()).filter(Boolean) ?? [];
  const pdfs = [...contenidoHtml.matchAll(/href="([^"]+\/PDF_Normas_Publicas\/[^"]+\.pdf)"/gi)].map((m) => hostPublico(m[1]));
  const materias = materiasDeNom(clave, titulo);
  let excluida: string | null = null;
  if (estado && !/vigente/i.test(estado)) excluida = `Estado: ${estado}`;
  else if (pdfs.length === 0) excluida = "Sin PDF público del texto en el catálogo (sólo enlace al DOF).";
  return { clave, titulo, estado, fechaDof, entradaEnVigor: vigor, dependencias: deps, url: pdfs[0] ?? null, urlFicha, materias, excluida };
}
