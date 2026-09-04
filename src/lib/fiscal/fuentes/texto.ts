// ─────────────────────────────────────────────────────────────────────────────
// Utilidades compartidas por los parsers de fuentes oficiales (PDF → texto).
// Todo lo que toca red o binarios vive aquí; los parsers son PUROS (texto →
// filas) para probarlos con los fixtures reales en vitest.
// ─────────────────────────────────────────────────────────────────────────────

const USER_AGENT = "Mozilla/5.0 (compatible; contabilidad-os/valores-fiscales)";

/** Descarga un PDF (o cualquier binario) como Buffer. Lanza si no es 200. */
export async function descargarBinario(url: string, timeoutMs = 60_000): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/pdf,*/*" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url} respondió ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** ¿Existe el recurso? (HEAD; algunos servidores no lo soportan → se prueba GET con Range). */
export async function existeUrl(url: string, timeoutMs = 20_000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const head = await fetch(url, { method: "HEAD", headers: { "User-Agent": USER_AGENT }, signal: ctrl.signal });
    if (head.ok) return true;
    if (head.status === 404 || head.status === 403) return false;
    const get = await fetch(url, { headers: { "User-Agent": USER_AGENT, Range: "bytes=0-0" }, signal: ctrl.signal });
    return get.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Texto de un PDF con pdf-parse v2 (misma técnica que fiscal-kb/ingest-leyes.ts:
 * require perezoso porque pdfjs toca DOMMatrix al cargar y rompe el build de Next).
 */
export async function textoDePdf(buffer: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PDFParse } = require("pdf-parse") as {
    PDFParse: new (opts: { data: Uint8Array }) => { getText(): Promise<{ text: string }>; destroy?(): Promise<void> };
  };
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const { text } = await parser.getText();
    return text;
  } finally {
    await parser.destroy?.();
  }
}

// ── Limpieza de texto de DOF ──────────────────────────────────────────────────

const RE_PAGINA = /^--\s*\d+\s+of\s+\d+\s*--$/;
const RE_ENCABEZADO_DOF = /^(?:DIARIO OFICIAL\s+)?(?:Lunes|Martes|Miércoles|Jueves|Viernes|Sábado|Domingo)\s+\d{1,2}\s+de\s+[a-záéíóú]+\s+de\s+\d{4}(?:\s+DIARIO OFICIAL)?$/i;
const RE_SOLO_PUNTOS = /^[.\s]+$/;

/** Quita saltos de página, encabezados «DIARIO OFICIAL …» y líneas de puntos; recorta las colas «…....». */
export function limpiarLineasDof(texto: string): string[] {
  const out: string[] = [];
  for (const raw of texto.split(/\r?\n/)) {
    const line = raw.replace(/\.{4,}/g, "").trim();
    if (!line) continue;
    if (RE_PAGINA.test(raw.trim()) || RE_ENCABEZADO_DOF.test(raw.trim()) || RE_SOLO_PUNTOS.test(raw)) continue;
    out.push(line);
  }
  return out;
}

const MESES: Record<string, number> = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };

/** «28 de diciembre de 2025» → «2025-12-28». Puro. */
export function fechaIso(dia: string | number, mes: string, anio: string | number): string | null {
  const m = MESES[mes.toLowerCase()];
  if (!m) return null;
  return `${anio}-${String(m).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

export function mesNumero(nombre: string): number | null {
  return MESES[nombre.toLowerCase()] ?? null;
}

/** «$1,033,190.00» / «1,033,190.00» / «0» → 1033190. */
export function montoNumero(s: string): number {
  return Number(s.replace(/[$,\s]/g, ""));
}

/** Primera fecha «D de MES de AAAA» que aparezca en el texto. */
export function primeraFecha(texto: string): string | null {
  const m = /(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i.exec(texto);
  return m ? fechaIso(m[1], m[2], m[3]) : null;
}
