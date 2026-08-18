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

// ── Reparación de lo ya dañado ───────────────────────────────────────────────

/**
 * Vocales acentuadas que el U+FFFD pudo haber reemplazado, para escribir reglas
 * que empaten con el texto sano Y con el dañado. Sin esto, cualquier regla que
 * mencione un acento —"COMISIÓN", "ENVÍO"— falla en todos los meses importados
 * antes de la corrección de codificación, que es justo donde más se necesita.
 */
export const O_ACENTO = "[oó�]";
export const I_ACENTO = "[ií�]";
export const U_ACENTO = "[uú�]";

/**
 * Palabras del vocabulario bancario donde el U+FFFD tiene UNA sola lectura
 * posible. "Comisi<?>n" sólo puede ser "Comisión": no existe otra palabra que
 * encaje. Por eso esta reparación es determinista y no una adivinanza.
 *
 * IMPORTANTE — esto NO edita lo que escribió el banco: repara lo que NOSOTROS
 * rompimos al decodificar mal el archivo. El byte que el banco mandó decía "ó";
 * leerlo como UTF-8 lo convirtió en U+FFFD. Devolverlo a "ó" restaura el
 * original, no lo altera.
 *
 * La lista es CERRADA y explícita a propósito. Una reparación por heurística
 * ("si hay <?> entre consonantes, prueba una vocal") acabaría inventando
 * nombres propios de contrapartes, y ahí sí estaríamos falsificando el estado
 * de cuenta.
 */
const REPARACIONES: ReadonlyArray<{ re: RegExp; acento: string }> = [
  { re: /(comisi)�(n)/gi, acento: "ó" },
  { re: /(env)�(o)/gi, acento: "í" },
  { re: /(n)�(mero)/gi, acento: "ú" },
  { re: /(autorizaci)�(n)/gi, acento: "ó" },
  { re: /(instituci)�(n)/gi, acento: "ó" },
  { re: /(dep)�(sito)/gi, acento: "ó" },
  { re: /(cr)�(dito)/gi, acento: "é" },
  { re: /(d)�(bito)/gi, acento: "é" },
  { re: /(devoluci)�(n)/gi, acento: "ó" },
  { re: /(operaci)�(n)/gi, acento: "ó" },
  { re: /(aplicaci)�(n)/gi, acento: "ó" },
  { re: /(descripci)�(n)/gi, acento: "ó" },
];

/**
 * Repara el mojibake de las palabras conocidas, respetando MAYÚSCULAS.
 *
 * Lo que no está en la lista se queda con su U+FFFD: preferible un carácter
 * roto y honesto a un nombre inventado.
 */
export function repararMojibake(texto: string): string {
  if (!texto || !texto.includes(REEMPLAZO)) return texto;
  let out = texto;
  for (const { re, acento } of REPARACIONES) {
    out = out.replace(re, (m: string, a: string, b: string) => {
      const enMayusculas = m === m.toUpperCase();
      return a + (enMayusculas ? acento.toUpperCase() : acento) + b;
    });
  }
  return out;
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
