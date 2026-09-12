/**
 * Traduce la NATURALEZA que caja escribe en su Excel a la etiqueta que el
 * cierre entiende.
 *
 * La columna CLIENTE del archivo dice qué es un movimiento cuando no lleva
 * factura: TRASPASO, nomina, BANCARIZACION, DEV DE FAC… Eso es lenguaje de
 * caja, no del motor. `postMonth` sólo acepta las etiquetas de
 * IGNORED_TAGS_VALIDOS y BLOQUEA el mes con «ignorado sin categoría» ante
 * cualquier otra cosa — así que guardar el texto del Excel tal cual deja los
 * movimientos marcados pero el mes sin poder cerrar.
 *
 * Lo que no se puede traducir con certeza devuelve null a propósito: vale más
 * un pendiente que una persona resuelve que una etiqueta inventada que mueve
 * saldos. Una devolución de SPEI, por ejemplo, no es un traspaso — se vincula
 * con su pago original (`devolucionDeId`) y para eso hace falta saber cuál es.
 */
export const NOTA_DE_CAJA = "Excel de conciliación de caja";

export function etiquetaDeNaturaleza(naturaleza: string | null | undefined): string | null {
  const n = (naturaleza ?? "").toUpperCase();
  if (!n.trim()) return null;
  // Movimiento entre cuentas propias: el dinero no entra ni sale de la empresa.
  // «nomina» es el mismo caso — caja traspasa a la cuenta desde la que dispersa.
  if (n.includes("TRASPASO") || n.includes("NOMINA")) return "INTERNAL_TRANSFER";
  return null;
}
