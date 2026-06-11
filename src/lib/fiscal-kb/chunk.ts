// Article-aware chunker for Mexican legal texts (leyes vigentes de la Cámara
// de Diputados). Splits on "Artículo N." boundaries so every chunk is a
// citable unit, carries the TÍTULO/CAPÍTULO/SECCIÓN breadcrumb for retrieval
// context, and sub-splits very long articles/transitorios with line overlap.
//
// Design doc: docs/FISCAL-KNOWLEDGE-BASE.md §6.

export interface LawChunk {
  articulo: string | null; // "113-E", "TRANSITORIOS"; null only for edge cases
  parte: number | null; // 1-based sub-chunk index when an article was split
  contexto: string | null; // "TÍTULO IV … › SECCIÓN IV DEL RÉGIMEN SIMPLIFICADO DE CONFIANZA"
  texto: string; // chunk text, breadcrumb included (improves embedding recall)
}

/** Max chars per chunk (~1.5K tokens). Articles under this stay whole. */
const MAX_CHUNK_CHARS = 6000;
/** Lines of overlap carried between sub-chunks of a long article. */
const OVERLAP_LINES = 2;

const ARTICLE_RE = /^Artículo (\d+[A-Za-zÑ-]*)\.(?=\s)/gm;
const TRANSITORIOS_RE = /^\s*(?:ARTÍCULOS?\s+)?TRANSITORIOS?\s*$/m;
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
      const subtitle = next && next === next.toUpperCase() && !HEADING_RE.test(next) && !/^Artículo/.test(next) ? ` ${next}` : "";
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
  const units: Unit[] = matches.map((m, i) => ({
    articulo: m[1],
    start: m.index!,
    end: matches[i + 1]?.index ?? cleanText.length,
  }));

  const chunks: LawChunk[] = [];
  const pushUnit = (articulo: string, body: string, start: number) => {
    const contexto = trailAt(breadcrumbs, start);
    const prefix = contexto ? `[${contexto}]\n` : "";
    const parts = subSplit(body.trim());
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
