// Chunkers for Mexican fiscal documents. Three shapes, one citable-unit model:
//   - "ley"  → "Artículo N." boundaries (leyes vigentes, Cámara de Diputados)
//   - "rmf"  → "N.N.N.N" regla numbering (Resolución Miscelánea Fiscal)
//   - "guia" → size-based windows w/ heading breadcrumbs (guías de llenado,
//              Anexo 20 — prose + tables, no clean article structure)
// Every chunk carries its structural breadcrumb (improves embedding recall)
// and sub-splits oversized units with line overlap.
//
// Design doc: docs/FISCAL-KNOWLEDGE-BASE.md §6.

/** Document shape — selects the chunking + cleaning strategy. */
export type DocKind = "ley" | "rmf" | "guia";

export interface LawChunk {
  articulo: string | null; // "113-E", "TRANSITORIOS", "2.7.1.32"; null = prose
  parte: number | null; // 1-based sub-chunk index when a unit was split
  contexto: string | null; // "TÍTULO IV … › SECCIÓN IV DEL RÉGIMEN SIMPLIFICADO DE CONFIANZA"
  texto: string; // chunk text, breadcrumb included (improves embedding recall)
}

/** Max chars per chunk (~1.5K tokens). Articles under this stay whole. */
const MAX_CHUNK_CHARS = 6000;
/** Lines of overlap carried between sub-chunks of a long article. */
const OVERLAP_LINES = 2;
/**
 * Tamaño objetivo de cada parte cuando un artículo largo se parte por
 * FRACCIONES (ver splitArticulo). Más chico que MAX_CHUNK_CHARS a propósito:
 * un embedding de 6 000 caracteres con seis fracciones distintas no se parece
 * a ninguna pregunta concreta.
 */
const TARGET_PART_CHARS = 2500;
/** Línea que arranca una fracción: «I. », «XXII. ». */
const FRACCION_RE = /^\s*[IVXLC]+\.\s/;

// Matches article headers across the notations used by Mexican leyes:
//   LISR style:  "Artículo 5.", "Artículo 113-E.", "Artículo 32-Bis."
//   LIVA/CFF:    "Artículo 5o.-", "Artículo 1o.-A.-" (ordinal o/º/° + ".-" intro)
//   LSS/LFT:     "Artículo 5 A.", "Artículo 15 B." (letra separada por espacio)
// Captures the number + optional suffix (drops the ordinal mark from the cite).
//   LIVA:        "Artículo 1o.-A.-" (ordinal, punto-guion, sufijo) → cita "1o-A"
//   CFF:         "Artículo 17-H Bis." → cita "17-H Bis"
// Captures the number + optional suffix (drops the ordinal mark from the cite).
// Leyes y códigos estatales / reglamentos impresos del DOF escriben el
// encabezado en mayúsculas — «ARTÍCULO 1.», «ARTICULO 158.-» (CDMX),
// «ARTÍCULO 11» a fin de línea (Orden Jurídico Poblano), «ARTÍCULO 30 BIS».
// En mayúsculas se acepta sin punto SÓLO a fin de línea: «Artículo 27 de la
// Ley» en prosa nunca es encabezado (test «no confunde una referencia»).
const NUM_ART = String.raw`\d+[oº°]?(?:\.?-[A-Za-zÑ]+)?(?: (?:Bis|BIS|Ter|TER))?|\d+ [A-Z]`;
// El Orden Jurídico Poblano también escribe «Artículo 129» solo en su renglón
// (sin punto): se acepta a fin de línea, como la forma en mayúsculas.
const ARTICLE_RE = new RegExp(String.raw`^(?:Artículo (${NUM_ART})(?:\.-?(?=\s)|[ \t]*$)|ART[ÍI]CULO (${NUM_ART})(?:\.-?(?=\s)|[ \t]*$))`, "gm");
/** Número tal como se cita: «5 A» → «5-A», «1o.-A» → «1o-A», «30 BIS» → «30 Bis». */
export function normalizarArticulo(n: string): string {
  return n
    .replace(/^(\d+) ([A-Z])$/, "$1-$2")
    .replace(".-", "-")
    .replace(/ (BIS|TER)$/i, (_, w: string) => ` ${w[0].toUpperCase()}${w.slice(1).toLowerCase()}`);
}
// La cola de una ley después del último artículo: «TRANSITORIOS», «ARTÍCULOS
// TRANSITORIOS DE DECRETOS DE REFORMA» y — lo que se tragaba el Art. 215 de
// la LISR (30 partes, 79 000 caracteres) — «DISPOSICIONES TRANSITORIAS DE LA
// LEY…» y «DISPOSICIONES DE VIGENCIA TEMPORAL…». Se corta en el PRIMER
// encabezado de este tipo y todo lo que sigue se cita «CLAVE — TRANSITORIOS».
const TRANSITORIOS_RE =
  /^\s*(?:DISPOSICIONES\s+(?:TRANSITORIAS|DE\s+VIGENCIA\s+TEMPORAL)\b[^\n]*|ARTÍCULOS?\s+TRANSITORIOS?(?:\s+DE\s+DECRETOS\s+DE\s+REFORMA)?|TRANSITORIOS?)\s*$/m;
const HEADING_RE = /^(TÍTULO|CAPÍTULO|SECCIÓN)\s+/;

/**
 * Strip the per-page header/footer noise the Cámara de Diputados PDFs repeat
 * on all pages (law title, "CÁMARA DE DIPUTADOS…", "Última Reforma DOF …",
 * "N de M" page markers).
 */
export function cleanLawText(raw: string): string {
  const lines = raw.split("\n");
  const title = lines.find((l) => l.trim().length > 0)?.trim() ?? "";
  const noise = [
    /^CÁMARA DE DIPUTADOS DEL H\. CONGRESO DE LA UNIÓN$/,
    /^Secretaría General$/,
    /^Secretaría de Servicios Parlamentarios$/,
    /^Última Reforma DOF \d{2}-\d{2}-\d{4}$/,
    /^\d+ de \d+$/, // page marker
    // pdf-parse (v2) marca cada salto de página; los PDF estatales lo traen.
    /^-- \d+ of \d+ --$/,
    // Orden Jurídico Poblano: encabezado de página de tres líneas + folio.
    /^Gobierno del Estado de Puebla$/,
    /^Secretaría de Gobernación$/,
    /^Secretaría de Servicios Legales y[^\n]*$/,
    /^Orden Jurídico Poblano$/,
    // Congreso / Consejería de la CDMX.
    /^CONGRESO DE LA CIUDAD DE MÉXICO$/,
    /^INSTITUTO DE INVESTIGACIONES LEGISLATIVAS$/,
    /^_{8,}$/,
    // Impresión del DOF (reglamentos que Diputados sirve como facsímil).
    /^\d+\s+\(\w+ Sección\)\s+DIARIO OFICIAL/,
    /DIARIO OFICIAL\s+(?:Lunes|Martes|Miércoles|Jueves|Viernes|Sábado|Domingo)\s+\d/,
    // Índice con puntos guía («ARTÍCULO 11 ............ 11») y folios sueltos.
    /^.{0,120}\.{5,}\s*\d{0,3}$/,
    /^\d{1,3}$/,
  ];
  let seenTitle = false;
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (t === title) {
      // Keep the first occurrence (document title), drop page-header repeats.
      if (seenTitle) return false;
      seenTitle = true;
      return true;
    }
    return !noise.some((re) => re.test(t));
  });
  return kept.join("\n");
}

/** Track the current TÍTULO/CAPÍTULO/SECCIÓN trail at a given text offset. */
function buildBreadcrumbIndex(text: string): { offset: number; trail: string }[] {
  const lines = text.split("\n");
  const trail: Record<string, string> = {};
  const order = ["TÍTULO", "CAPÍTULO", "SECCIÓN"];
  const index: { offset: number; trail: string }[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const m = t.match(HEADING_RE);
    if (m) {
      const level = m[1];
      // Heading subtitle usually follows on the next line in uppercase
      // (e.g. "SECCIÓN IV" / "DEL RÉGIMEN SIMPLIFICADO DE CONFIANZA").
      const next = lines[i + 1]?.trim() ?? "";
      const subtitle = next && next === next.toUpperCase() && !HEADING_RE.test(next) && !/^Art[íi]culo/i.test(next) ? ` ${next}` : "";
      trail[level] = `${t}${subtitle}`;
      // A new TÍTULO resets CAPÍTULO/SECCIÓN; a new CAPÍTULO resets SECCIÓN.
      for (const lower of order.slice(order.indexOf(level) + 1)) delete trail[lower];
      index.push({ offset, trail: order.filter((k) => trail[k]).map((k) => trail[k]).join(" › ") });
    }
    offset += lines[i].length + 1;
  }
  return index;
}

function trailAt(index: { offset: number; trail: string }[], offset: number): string | null {
  let current: string | null = null;
  for (const e of index) {
    if (e.offset > offset) break;
    current = e.trail;
  }
  return current;
}

/** Sub-split a long unit at line boundaries with a small overlap. */
function subSplit(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const lines = text.split("\n");
  const parts: string[] = [];
  let buf: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > MAX_CHUNK_CHARS && buf.length > 0) {
      parts.push(buf.join("\n"));
      buf = buf.slice(-OVERLAP_LINES); // carry overlap
      size = buf.reduce((s, l) => s + l.length + 1, 0);
    }
    buf.push(line);
    size += line.length + 1;
  }
  if (buf.length > OVERLAP_LINES || parts.length === 0) parts.push(buf.join("\n"));
  return parts;
}

/**
 * Parte un artículo largo por FRACCIONES, repitiendo el encabezado del
 * artículo en cada parte.
 *
 * Hallazgo del eval (Fase 1): «Art. 27 LISR» (requisitos de las deducciones,
 * 29 000 caracteres) se partía en 5 ventanas de 6 000 cortadas a media
 * oración; las partes 2–5 no decían «Artículo 27» ni «requisitos de las
 * deducciones», así que su embedding no sabía de qué artículo era. Doce de las
 * 80 preguntas del eval esperan ese artículo y casi todas fallaban.
 *
 * Ahora: cada parte empieza en una fracción, cabe en ~TARGET_PART_CHARS y
 * lleva el primer renglón del artículo («Artículo 27. Las deducciones …
 * requisitos:») como encabezado. Un artículo largo sin fracciones (o una
 * fracción monstruosa) se parte por tamaño como antes.
 */
function splitArticulo(body: string): string[] {
  if (body.length <= MAX_CHUNK_CHARS) return [body];
  const lines = body.split("\n");
  // Segmentos: el preámbulo (encabezado + texto antes de la 1ª fracción) y
  // luego una fracción por segmento.
  const segmentos: string[][] = [[]];
  for (const line of lines) {
    if (FRACCION_RE.test(line) && segmentos[segmentos.length - 1].length > 0) segmentos.push([]);
    segmentos[segmentos.length - 1].push(line);
  }
  if (segmentos.length < 3) return subSplit(body);

  const encabezado = lines[0].trim().slice(0, 300);
  const parts: string[] = [];
  let buf: string[] = [];
  let size = 0;
  const flush = () => {
    if (buf.length > 0) parts.push(buf.join("\n"));
    buf = [];
    size = 0;
  };
  for (const [i, seg] of segmentos.entries()) {
    const texto = seg.join("\n");
    // El preámbulo (encabezado + texto antes de la fracción I) nunca va solo:
    // un chunk de 200 caracteres con «…los siguientes requisitos:» no sirve.
    const soloPreambulo = i === 1 && buf.length === 1;
    if (size > 0 && !soloPreambulo && size + texto.length + 1 > TARGET_PART_CHARS) flush();
    if (texto.length > MAX_CHUNK_CHARS) {
      flush();
      parts.push(...subSplit(texto));
      continue;
    }
    buf.push(texto);
    size += texto.length + 1;
  }
  flush();
  return parts.map((p, i) => (i === 0 ? p : `${encabezado} (continúa)\n${p}`));
}

/**
 * Quita el ÍNDICE de los códigos estatales: una corrida de ≥ 8 «artículos»
 * seguidos cuyo cuerpo es sólo el encabezado («ARTÍCULO 11» + folio) son entradas de
 * índice, no artículos; sin esto cada artículo saldría dos veces (la entrada
 * vacía primero) y el número de página pegado («ARTÍCULO 25129») se citaría
 * como artículo. Los artículos derogados («Artículo 8. (Se deroga).») también
 * son cortos pero no forman corridas de 8 sin decirlo. Puro.
 */
export function sinIndice<U extends { start: number; end: number; articulo?: string }>(units: U[], texto: string, minCorrida = 8, maxResto = 40): U[] {
  const folioPegado = units.map((u) => /^\s*(?:Artículo|ART[ÍI]CULO)\s+\d{5,}/i.test(texto.slice(u.start, u.end)));
  const esIndice = units.map((u, i) => {
    if (folioPegado[i]) return true;
    const cuerpo = texto.slice(u.start, u.end);
    // Una entrada de índice es SÓLO el encabezado (y a lo más un folio): tras
    // quitar «ARTÍCULO 11», los renglones de título en mayúsculas (CAPÍTULO…,
    // DE LOS RECURSOS…) y los puntos guía, no queda prosa. Un artículo real
    // siempre trae texto.
    const resto = cuerpo
      .replace(/^\s*(?:Artículo|ART[ÍI]CULO)\s+\S+(?:\s+(?:Bis|BIS|Ter|TER))?\.?-?/, "")
      .split("\n")
      .filter((l) => l.trim() && l.trim() !== l.trim().toUpperCase() && !/\.{5,}/.test(l))
      .join(" ")
      .replace(/\b\d{1,3}\b/g, "")
      .replace(/[\s.]+/g, " ")
      .trim();
    return resto.length < maxResto && !/derog/i.test(cuerpo);
  });
  const quitar = new Array<boolean>(units.length).fill(false);
  // 1) Un folio pegado al número («Artículo 139608» = artículo 139, página 608)
  //    sólo ocurre en índices: ninguna ley numera con 5 dígitos.
  folioPegado.forEach((f, i) => {
    if (f) quitar[i] = true;
  });
  // 2) Corridas de entradas vacías.
  let i = 0;
  while (i < units.length) {
    if (!esIndice[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < units.length && esIndice[j]) j++;
    if (j - i >= minCorrida) for (let k = i; k < j; k++) quitar[k] = true;
    i = j;
  }
  // 3) Una entrada vacía suelta cuyo número también aparece con texto real
  //    («Artículo 27» pegado de «Artículo 2 … 7» junto al 27 verdadero).
  const conTexto = new Set(units.filter((u, k) => !esIndice[k] && u.articulo).map((u) => u.articulo));
  units.forEach((u, k) => {
    if (esIndice[k] && u.articulo && conTexto.has(u.articulo)) quitar[k] = true;
  });
  return units.filter((_, k) => !quitar[k]);
}

/**
 * Corrige los números con nota al pie pegada del Orden Jurídico Poblano: el
 * PDF imprime «Artículo 2» + la llamada «7» de la reforma como «Artículo 27»,
 * «Artículo 5» + «15» como «Artículo 515», «Artículo 139» + «608» como
 * «Artículo 139608». Los artículos van en secuencia, así que si el número leído
 * empieza con el que toca (anterior + 1) y trae dígitos de más, es ese. Un
 * salto real (artículo derogado o «14» tras «12») no empieza con el esperado
 * y se respeta. Puro.
 */
export function corregirNotasPegadas<U extends { articulo: string }>(units: U[]): U[] {
  let prev: number | null = null;
  return units.map((u) => {
    if (!/^\d+$/.test(u.articulo)) {
      const m = /^(\d+)/.exec(u.articulo);
      if (m) prev = Number(m[1]);
      return u;
    }
    const n = Number(u.articulo);
    if (prev !== null) {
      const esperado = String(prev + 1);
      if (u.articulo.length > esperado.length && u.articulo.startsWith(esperado)) {
        prev = prev + 1;
        return { ...u, articulo: esperado };
      }
    }
    prev = n;
    return u;
  });
}

/**
 * Chunk a cleaned law text into citable units.
 *
 * - Everything before the first "Artículo 1." (decree boilerplate, índice) is
 *   skipped — low retrieval value, high noise.
 * - The tail after the last article is split off at the TRANSITORIOS heading
 *   so vigencia rules don't get mislabeled with the last article's number.
 */
export function chunkLaw(cleanText: string): LawChunk[] {
  const breadcrumbs = buildBreadcrumbIndex(cleanText);
  const matches = [...cleanText.matchAll(ARTICLE_RE)];
  if (matches.length === 0) {
    // Not an article-structured document — fall back to plain sub-splitting.
    return subSplit(cleanText).map((texto, i, all) => ({
      articulo: null,
      parte: all.length > 1 ? i + 1 : null,
      contexto: null,
      texto,
    }));
  }

  type Unit = { articulo: string; start: number; end: number };
  const todas: Unit[] = matches.map((m, i) => ({
    // «5 A» (LSS/LFT) se cita «5-A», como los sufijos de LISR («113-E»). El
    // ordinal de LIVA/CFF («5o») se conserva tal cual: así lee la ley, y
    // cambiarlo dejaría citas mixtas hasta re-ingerir todo con force.
    articulo: normalizarArticulo(m[1] ?? m[2]),
    start: m.index!,
    end: matches[i + 1]?.index ?? cleanText.length,
  }));
  const units = corregirNotasPegadas(sinIndice(todas, cleanText));

  const chunks: LawChunk[] = [];
  const pushUnit = (articulo: string, body: string, start: number) => {
    const contexto = trailAt(breadcrumbs, start);
    const prefix = contexto ? `[${contexto}]\n` : "";
    const parts = articulo === "TRANSITORIOS" ? subSplit(body.trim()) : splitArticulo(body.trim());
    for (let i = 0; i < parts.length; i++) {
      chunks.push({
        articulo,
        parte: parts.length > 1 ? i + 1 : null,
        contexto,
        texto: `${prefix}${parts[i]}`,
      });
    }
  };

  for (const u of units) {
    let body = cleanText.slice(u.start, u.end);
    // Last unit usually swallows the TRANSITORIOS tail — split it off.
    const tMatch = body.match(TRANSITORIOS_RE);
    if (tMatch && tMatch.index !== undefined && tMatch.index > 0) {
      const tail = body.slice(tMatch.index);
      body = body.slice(0, tMatch.index);
      pushUnit(u.articulo, body, u.start);
      pushUnit("TRANSITORIOS", tail, u.start + tMatch.index);
      continue;
    }
    pushUnit(u.articulo, body, u.start);
  }
  return chunks;
}

// ─── RMF (reglas) ────────────────────────────────────────────────────────────

// Reglas are 4-level decimal numbers at the start of a line, e.g. "2.7.1.32."
// Capítulo/sección headers ("2.7. Comprobantes…") seed the breadcrumb.
const REGLA_RE = /^\s*(\d+\.\d+\.\d+\.\d+)\.?\s/gm;
const RMF_HEADING_RE = /^\s*(\d+\.(?:\d+\.){0,2})\s+[A-ZÁÉÍÓÚ]/;

/**
 * Chunk a Resolución Miscelánea Fiscal by regla number. Falls back to the
 * generic chunker when no regla numbering is found (defensive — RMF layouts
 * from DOF vs SAT-compiled differ).
 */
export function chunkRegla(cleanText: string): LawChunk[] {
  const matches = [...cleanText.matchAll(REGLA_RE)];
  if (matches.length < 5) return chunkGeneric(cleanText);

  // Breadcrumb trail from capítulo/sección headers.
  const headIndex: { offset: number; trail: string }[] = [];
  {
    const lines = cleanText.split("\n");
    let offset = 0;
    for (const line of lines) {
      const m = line.match(RMF_HEADING_RE);
      if (m) headIndex.push({ offset, trail: line.trim().slice(0, 90) });
      offset += line.length + 1;
    }
  }

  const chunks: LawChunk[] = [];
  for (let i = 0; i < matches.length; i++) {
    const regla = matches[i][1];
    const start = matches[i].index!;
    const end = matches[i + 1]?.index ?? cleanText.length;
    const contexto = trailAt(headIndex, start);
    const prefix = contexto ? `[${contexto}]\n` : "";
    const parts = subSplit(cleanText.slice(start, end).trim());
    for (let p = 0; p < parts.length; p++) {
      chunks.push({ articulo: regla, parte: parts.length > 1 ? p + 1 : null, contexto, texto: `${prefix}${parts[p]}` });
    }
  }
  return chunks;
}

// ─── Guías de llenado (prose + tables) ───────────────────────────────────────

const GUIA_HEADING_RE = /^\s*(?:[IVXLC]+\.\s+|Apéndice\s+\d+|Capítulo\s|Glosario)/;

/**
 * Size-based windows for documents without clean article/regla structure
 * (guías de llenado, Anexo 20). Each chunk is tagged with the nearest
 * preceding heading as its contexto so citations stay traceable.
 */
export function chunkGeneric(cleanText: string): LawChunk[] {
  const lines = cleanText.split("\n");
  const headIndex: { offset: number; trail: string }[] = [];
  let offset = 0;
  for (const line of lines) {
    if (GUIA_HEADING_RE.test(line) && line.trim().length < 120) {
      headIndex.push({ offset, trail: line.trim().replace(/\.{3,}.*$/, "").slice(0, 90) });
    }
    offset += line.length + 1;
  }

  const parts = subSplit(cleanText.trim());
  const chunks: LawChunk[] = [];
  let cursor = 0;
  for (let i = 0; i < parts.length; i++) {
    const contexto = trailAt(headIndex, cursor);
    chunks.push({
      articulo: null,
      parte: parts.length > 1 ? i + 1 : null,
      contexto,
      texto: contexto ? `[${contexto}]\n${parts[i]}` : parts[i],
    });
    cursor += parts[i].length;
  }
  return chunks;
}

// ─── Generic cleaning + dispatch ─────────────────────────────────────────────

/**
 * Light cleaning for non-ley documents: drop standalone page numbers and
 * table-of-contents dot-leader lines. Deliberately conservative — over-cleaning
 * guías (where repeated lines like "Ejemplo:" are real content) loses signal.
 */
export function cleanGenericText(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (/^\d{1,4}$/.test(t)) return false; // bare page number
      if (/\.{6,}\s*\d+\s*$/.test(t)) return false; // "Glosario .......... 54" TOC leader
      return true;
    })
    .join("\n");
}

/** Clean + chunk a document according to its kind. */
export function chunkDocument(rawText: string, kind: DocKind): LawChunk[] {
  if (kind === "ley") return chunkLaw(cleanLawText(rawText));
  const clean = cleanGenericText(rawText);
  return kind === "rmf" ? chunkRegla(clean) : chunkGeneric(clean);
}
