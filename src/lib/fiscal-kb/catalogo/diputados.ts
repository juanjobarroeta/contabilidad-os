// ─────────────────────────────────────────────────────────────────────────────
// Catálogo federal generado desde el índice de la Cámara de Diputados
// (https://www.diputados.gob.mx/LeyesBiblio/index.htm): 317 ordenamientos
// vigentes (CPEUM, códigos, leyes federales y generales, LIF/PEF) con su PDF,
// su página de reformas, la fecha de publicación original y la de la última
// reforma. Todo puro: el script scripts/fiscal-catalogo-diputados.ts descarga
// el HTML y escribe catalogo/federal.json; la ingesta (ingest-leyes.ts) lo lee.
//
// docs/MOTOR-JURIDICO.md §5.2.
// ─────────────────────────────────────────────────────────────────────────────

import { clasificarMaterias, type Materia } from "../materias";

export const DIPUTADOS_BASE = "https://www.diputados.gob.mx/LeyesBiblio/";
export const DIPUTADOS_INDEX_URL = `${DIPUTADOS_BASE}index.htm`;

/** Una fila del índice, tal como la publica Diputados. */
export interface FilaIndice {
  numero: string; // "001" … "317"; "A" = abrogada listada aparte
  titulo: string;
  archivo: string; // nombre del PDF sin extensión ("CCom", "10_270614")
  urlPdf: string;
  urlRef: string | null;
  /** Fecha de publicación original en el DOF (YYYY-MM-DD). */
  dofOriginal: string | null;
  /** Última reforma según el índice (YYYY-MM-DD); null si «Sin reforma». */
  ultimaReforma: string | null;
  /** Texto suelto de la fila: «Ley Abrogada DOF …», «Declaratoria de Invalidez…», «Ley en vigor el …». */
  anotaciones: string;
}

/** Entrada del catálogo que consume la ingesta. */
export interface EntradaCatalogo {
  clave: string;
  titulo: string;
  url: string;
  urlRef: string | null;
  archivo: string;
  dofOriginal: string | null;
  ultimaReforma: string | null;
  /** ultimaReforma ?? dofOriginal: la vigencia si el PDF no declara «Última reforma DOF». */
  vigenciaFallback: string | null;
  materias: Materia[];
  /** null = se ingiere; texto = por qué no. */
  excluida: string | null;
}

function ddmmyyyy(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&(aacute|eacute|iacute|oacute|uacute|ntilde|Aacute|Eacute|Iacute|Oacute|Uacute|Ntilde|uuml|Uuml);/g, (_, e) => {
      const map: Record<string, string> = { aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", uuml: "ü", Uuml: "Ü" };
      return map[e] ?? "";
    });
}

function textoPlano(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/**
 * Filas del índice: cada <tr> con un enlace a pdf/*.pdf. El texto de la fila
 * es «NNN TÍTULO DOF dd/mm/aaaa [anotaciones] DOF dd/mm/aaaa | Sin reforma».
 */
export function parsearIndice(html: string): FilaIndice[] {
  const filas: FilaIndice[] = [];
  for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const hrefs = [...tr.matchAll(/href="([^"]+)"/gi)].map((m) => m[1]);
    const pdf = hrefs.find((h) => /^pdf\/[^/]+\.pdf$/i.test(h));
    if (!pdf) continue;
    const ref = hrefs.find((h) => /^ref\/[^/]+\.htm$/i.test(h)) ?? null;
    const texto = textoPlano(tr);
    const m = texto.match(/^(\d{3}|[A-Z])\s+(.+?)\s+DOF\s+(\d{2}\/\d{2}\/\d{4})(.*)$/);
    if (!m) continue;
    const [, numero, titulo, orig, resto] = m;
    // La última reforma es el ÚLTIMO «DOF dd/mm/aaaa» del resto; si el resto
    // dice «Sin reforma» no hay. «Ley Abrogada DOF …» es anotación, no reforma.
    const fechas = [...resto.matchAll(/DOF\s+(\d{2}\/\d{2}\/\d{4})/g)].map((x) => x[1]);
    const abrogada = /Ley Abrogada|Abrogad[ao]\s+DOF/i.test(resto);
    const ultima = !abrogada && fechas.length > 0 ? ddmmyyyy(fechas[fechas.length - 1]) : null;
    const anotaciones = resto
      .replace(/DOF\s+\d{2}\/\d{2}\/\d{4}/g, " ")
      .replace(/\b(Sin reforma|Nueva reforma|Nueva Ley|Nuevas reformas|Nueva modificaci[óo]n|Nueva fe de erratas|Word|Notificaci[óo]n|Sentencia SCJN)\b/gi, " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s|]+|[\s|]+$/g, "")
      .trim();
    filas.push({
      numero,
      titulo: titulo.replace(/\s+/g, " ").trim(),
      archivo: pdf.slice(4, -4),
      urlPdf: `${DIPUTADOS_BASE}${pdf}`,
      urlRef: ref ? `${DIPUTADOS_BASE}${ref}` : null,
      dofOriginal: ddmmyyyy(orig),
      ultimaReforma: ultima,
      anotaciones,
    });
  }
  return filas;
}

/**
 * Claves que no salen del nombre del archivo: Diputados nombra ~50 PDFs con un
 * número («79.pdf», «10_270614.pdf») y algunos con la clave de otro sistema
 * (LIFNVT = la LINFONAVIT que ya está en la base). Revisadas a mano; una
 * clave nueva se agrega aquí, nunca se inventa en el JSON.
 */
export const CLAVE_POR_ARCHIVO: Record<string, string> = {
  CCom: "CCOM",
  LIFNVT: "LINFONAVIT",
  LAdua: "LADUA",
  LAgra: "LAGRA",
  LAmp: "LAMP",
  LAmn: "LAMN",
  LAero: "LAERO",
  LASoc: "LASOC",
  LBio: "LBIO",
  LGeo: "LGEO",
  LGAg: "LGAG",
  LMin: "LMIN",
  LMigra: "LMIGRA",
  LPlan: "LPLAN",
  LViv: "LVIV",
  LICal_010720: "LICAL",
  LIF_2026: "LIF",
  LIGIE_2022: "LIGIE",
  LSInt_300519: "LSINT",
  LFCPo_190521: "LFCPO",
  LFRemSP_190521: "LFREMSP",
  LRArt3_MMCE_300919: "LRART3-MMCE",
  LRArt6_MDR: "LRART6-MDR",
  LRArt76_fracVI: "LRART76-VI",
  LRFXIIIB_Art123: "LRART123-XIIIBIS",
  LRFIyII_Art105: "LRART105",
  PEF_2026: "PEF",
  Reg_Diputados: "RCD",
  Reg_Senado: "RSR",
  "10_270614": "EGDF",
  "79": "LISEDIP",
  "19": "LAMN-1994",
  "238": "LCP",
  "30": "LCMOPFIH",
  "246": "LEC",
  "35": "LEXP",
  "36_200521": "LEI",
  "252": "LDISPAM",
  "53": "LNAC",
  "57": "LOG",
  "63": "LPCINE",
  "65_071220": "LPUERTOS",
  "70": "LSRLIP",
  "71_240418": "LSSS",
  "256": "LTFCCG",
  "74": "LBM",
  "75_100619": "LDOF",
  "269_200521": "LRPV",
  "93_041218": "LSAT",
  "96_190418": "LSEM",
  "260": "LSPCAPF",
  "105": "LFCP",
  "109": "LFJS",
  "136_300118": "LFDP",
  "124": "LFM",
  "157": "LOUAM",
  "158": "LOUNAM",
  "159": "LOTA",
  "162": "LONAFIN",
  "164_190719": "LOBB",
  "167": "LOBANJERCITO",
  "170_171215": "LOINAH",
  "171": "LOIPN",
  "176_210618": "LCNP",
  "177": "LDCPDC",
  "268": "LCACSAM",
  "187_291214": "LABDC",
  "192": "LFGFAGA",
  "193_171215": "LINBAL",
  "195": "LUACH",
  "196": "LUEFA",
  "197": "LRMNU",
  "200_291214": "LBID",
  "202": "LRART76-V",
  "204": "LRART73-XVIII",
  "207": "LRART27-NUCLEAR",
  "208_190118": "LPROF",
  "23": "LCA",
  "211": "LSCS",
  "218": "OGA",
  "271": "LATIME",
  "219": "RGICG",
};

/** Ordenamientos del índice que NO se ingieren, con el porqué. */
export const EXCLUSIONES: Record<string, string> = {
  PEF: "Presupuesto de Egresos: tablas presupuestales, no texto normativo citable por artículo.",
  LIGIE: "Tarifa arancelaria: miles de páginas de fracciones en tabla; el chunker por artículo no aplica.",
  LSINT: "Declaratoria de invalidez de la ley (DOF 30/05/2019).",
  LGMIME: "Declaratoria de invalidez de la ley (DOF 24/11/2023).",
  LTPCPIMCP: "Declaratoria de invalidez de la ley (SCJN).",
};

/** Clave canónica: la revisada a mano o el archivo en mayúsculas sin sufijo de fecha. */
export function claveDesdeArchivo(archivo: string): string {
  const manual = CLAVE_POR_ARCHIVO[archivo];
  if (manual) return manual;
  const base = archivo.replace(/_(\d{6}|\d{4})$/, "").replace(/_/g, "-").toUpperCase();
  if (!/[A-Z]/.test(base)) {
    throw new Error(`Archivo «${archivo}» no tiene clave: agrégala a CLAVE_POR_ARCHIVO`);
  }
  return base;
}

/** Título con mayúscula inicial en vez de la palabra en VERSALES del índice («LEY del…» → «Ley del…»). */
export function normalizarTitulo(t: string): string {
  return t
    .replace(/^(CONSTITUCIÓN|CÓDIGO|LEY|ESTATUTO|IMPUESTO|ORDENANZA|PRESUPUESTO|REGLAMENTO)\b/, (w) => w[0] + w.slice(1).toLowerCase())
    .replace(/\s*\(Antes\s+"[^"]*"\s*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Filas → entradas del catálogo, con clave canónica, materias y exclusiones. Falla ante claves duplicadas. */
export function construirCatalogo(filas: FilaIndice[]): EntradaCatalogo[] {
  const vistas = new Map<string, string>();
  const out: EntradaCatalogo[] = [];
  for (const f of filas) {
    const clave = claveDesdeArchivo(f.archivo);
    const previa = vistas.get(clave);
    if (previa) throw new Error(`Clave duplicada «${clave}»: ${previa} y ${f.archivo}`);
    vistas.set(clave, f.archivo);
    const titulo = normalizarTitulo(f.titulo);
    let excluida: string | null = EXCLUSIONES[clave] ?? null;
    if (!excluida && f.numero === "A") excluida = `Abrogada: ${f.anotaciones || "listada como abrogada en el índice"}`;
    if (!excluida && /Declaratoria de Invalidez de la Ley/i.test(f.anotaciones) && !/Recupera vigencia/i.test(f.anotaciones)) {
      excluida = `Declaratoria de invalidez: ${f.anotaciones}`;
    }
    out.push({
      clave,
      titulo,
      url: f.urlPdf,
      urlRef: f.urlRef,
      archivo: f.archivo,
      dofOriginal: f.dofOriginal,
      ultimaReforma: f.ultimaReforma,
      vigenciaFallback: f.ultimaReforma ?? f.dofOriginal,
      materias: clasificarMaterias(clave, titulo),
      excluida,
    });
  }
  return out;
}
