// ─────────────────────────────────────────────────────────────────────────────
// Decodificar el estado de cuenta a texto SIN romper los acentos.
//
// EL BUG QUE ESTO ARREGLA: el front leía los CSV con `await file.text()`, que
// SIEMPRE decodifica UTF-8. Los bancos mexicanos exportan en Windows-1252, así
// que "Comisión por Transferencia - Envío" llegaba como "Comisi<?>n por
// Transferencia - Env<?>o" — y el daño ocurría EN EL NAVEGADOR, antes de que el
// servidor viera un solo byte. Una vez que el carácter se volvió U+FFFD, el byte
// original ya no existe: no hay forma de recuperarlo del texto.
//
// Por eso la corrección tiene dos mitades y ninguna sirve sola:
//   1. el front manda BYTES (base64), no texto ya decodificado;
//   2. aquí se decide la codificación mirando los bytes.
//
// Consecuencia práctica: cualquier búsqueda por "comisión" fallaba en esos
// renglones, y el mes que se importó mal se queda mal hasta reimportarlo.
//
// PURO.
// ─────────────────────────────────────────────────────────────────────────────

/** Carácter de reemplazo: la marca de que UTF-8 no era la codificación. */
const REEMPLAZO = "�";

export type Codificacion = "utf8" | "utf8-bom" | "utf16le" | "utf16be" | "windows-1252";

export interface TextoDecodificado {
  texto: string;
  codificacion: Codificacion;
}

/**
 * Decodifica los bytes de un estado de cuenta.
 *
 * Orden: BOM explícito (no se adivina lo que el archivo ya declaró) → UTF-8 si
 * sale limpio → Windows-1252 como respaldo. Ese respaldo es el que rescata los
 * acentos: es lo que exportan Bajío, Banorte y compañía.
 *
 * UTF-8 va antes que Windows-1252 porque el error caro es el inverso: un archivo
 * UTF-8 leído como Windows-1252 no falla ruidosamente, sólo convierte cada acento
 * en dos caracteres de basura ("ComisiÃ³n") que pasan inadvertidos.
 */
export function decodificarEstadoDeCuenta(buf: Buffer | Uint8Array): TextoDecodificado {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return { texto: b.subarray(3).toString("utf8"), codificacion: "utf8-bom" };
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return { texto: b.subarray(2).toString("utf16le"), codificacion: "utf16le" };
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    // Node no decodifica UTF-16BE: se voltean los pares y se lee como LE.
    // `swap16` muta, así que se trabaja sobre una copia.
    const copia = Buffer.from(b.subarray(2));
    return { texto: copia.swap16().toString("utf16le"), codificacion: "utf16be" };
  }

  const utf8 = b.toString("utf8");
  if (!utf8.includes(REEMPLAZO)) return { texto: utf8, codificacion: "utf8" };

  return {
    texto: new TextDecoder("windows-1252").decode(b),
    codificacion: "windows-1252",
  };
}

/** ¿Este texto ya viene dañado sin remedio (tiene U+FFFD)? */
export function tieneMojibake(texto: string): boolean {
  return texto.includes(REEMPLAZO);
}

// ── Sniffing de formato ──────────────────────────────────────────────────────

/**
 * ¿Los bytes son un Excel BINARIO de verdad?
 *
 * Se decide por FIRMA, no por la extensión, porque la extensión miente en los
 * dos sentidos: los exports .xls de BBVA son XML (SpreadsheetML) y hay CSV que
 * llegan con nombre .xls. Mandar un CSV a SheetJS lo re-emite con su propia
 * idea de la codificación — otra fuente de acentos rotos.
 *
 *   PK    (50 4B) → zip = .xlsx/.xlsm
 *   ÐÏ    (D0 CF) → OLE2 = .xls binario viejo
 */
export function esExcelBinario(buf: Buffer | Uint8Array): boolean {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 2) return false;
  const zip = b[0] === 0x50 && b[1] === 0x4b;
  const ole2 = b[0] === 0xd0 && b[1] === 0xcf;
  return zip || ole2;
}

/** ¿Es SpreadsheetML 2003 (el .xls de BBVA que en realidad es XML)? */
export function esSpreadsheetML(texto: string): boolean {
  return /mso-application|urn:schemas-microsoft-com:office:spreadsheet|<Workbook/i.test(
    texto.slice(0, 4096)
  );
}
