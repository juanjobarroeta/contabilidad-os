// ─────────────────────────────────────────────────────────────────────────────
// Cortar un estado de cuenta en LOTES DE PÁGINAS antes de extraerlo.
//
// POR QUÉ EXISTE. La extracción mandaba el PDF entero en UNA llamada con
// `max_tokens: 8000`. El estado de agosto de este hospital trae 168 movimientos
// en 17 páginas: en JSON son ~20 000 tokens de salida, así que la respuesta se
// cortaba a la mitad, `JSON.parse` fallaba, y el usuario leía «intenta con un
// archivo más claro» — culpando a su archivo de un techo nuestro. El de Banorte,
// con 267 renglones, ni siquiera alcanzaba a terminar antes de los 120 s de la
// ruta.
//
// Cortado en lotes chicos, cada llamada devuelve pocos movimientos, ninguna se
// acerca al techo, y como los lotes son independientes corren EN PARALELO: el
// tiempo total es el del lote más lento, no la suma.
//
// Se usa qpdf (WASM), el mismo que ya desencripta los PDFs protegidos — sin
// binarios nativos y sin dependencia nueva.
// ─────────────────────────────────────────────────────────────────────────────

import { runQpdf } from "./pdf-crypt";

/** Páginas por lote. Un estado bancario trae ~10-12 movimientos por página, así
 *  que 4 páginas ≈ 45 movimientos ≈ 6 000 tokens de JSON: sobra margen bajo el
 *  techo y cada llamada termina en segundos. */
export const PAGINAS_POR_LOTE = 4;

/**
 * Páginas y texto del PDF, en una sola pasada.
 *
 * El texto NO se usa para extraer los movimientos —la distinción entre cargo y
 * abono vive en la POSICIÓN de la columna, y aplanar el PDF a texto la pierde;
 * confundir un cargo con un abono equivoca el movimiento por el doble de su
 * importe. Se usa para leer los TOTALES DE CONTROL que el propio banco imprime
 * (cuántos depósitos, cuántos retiros y por cuánto), que son con lo que después
 * se coteja la extracción.
 *
 * Devuelve `null` cuando el PDF no da texto (escaneado): ahí no hay controles
 * que leer y el corte por páginas cae al número que reporte pdf-parse.
 */
export async function leerPdf(buf: Buffer): Promise<{ paginas: number; texto: string } | null> {
  try {
    // require perezoso: pdf-parse arrastra pdfjs, que toca DOMMatrix al cargar
    // y rompe el paso de build de Next. Mismo patrón que fiscal-kb/pdf.ts.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PDFParse } = require("pdf-parse") as {
      PDFParse: new (opts: { data: Uint8Array }) => {
        getText(): Promise<{ text: string; pages?: unknown[] }>;
      };
    };
    const r = await new PDFParse({ data: new Uint8Array(buf) }).getText();
    return { paginas: r.pages?.length ?? 0, texto: r.text ?? "" };
  } catch (e) {
    console.error("[pdf-paginas] no se pudo leer el PDF:", e);
    return null;
  }
}

/** Los rangos de página de cada lote, 1-based e inclusivos. PURA. */
export function rangosDeLotes(paginas: number, porLote = PAGINAS_POR_LOTE): [number, number][] {
  if (paginas <= 0) return [];
  const rangos: [number, number][] = [];
  for (let desde = 1; desde <= paginas; desde += porLote) {
    rangos.push([desde, Math.min(desde + porLote - 1, paginas)]);
  }
  return rangos;
}

/** Extrae un rango de páginas como PDF independiente. null si qpdf falla. */
export async function recortarPaginas(
  buf: Buffer,
  desde: number,
  hasta: number,
): Promise<Buffer | null> {
  // NUNCA lanza. El corte es una OPTIMIZACIÓN, no un requisito: si qpdf no está
  // disponible se extrae el documento completo, como antes. Que esto tirara una
  // excepción convirtió una mejora en una caída — el camino de qpdf sólo se
  // había ejercitado con PDFs protegidos (casi nunca), y al ponerlo en cada
  // subida su primer tropiezo llegó al usuario como «e is not a function».
  try {
    const { code, out, stderr } = await runQpdf(
      ["in.pdf", "--pages", ".", `${desde}-${hasta}`, "--", "out.pdf"],
      buf,
    );
    if ((code === 0 || code === 3) && out) return out;
    console.error(`[pdf-paginas] recorte ${desde}-${hasta} falló:`, stderr.trim().slice(0, 200));
    return null;
  } catch (e) {
    console.error(`[pdf-paginas] recorte ${desde}-${hasta} lanzó:`, e);
    return null;
  }
}
