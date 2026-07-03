/**
 * Regla de conteo para deduplicar movimientos bancarios al importar.
 *
 * El CSV del banco es la fuente de verdad: perder filas en silencio es el
 * peor error posible. Dos movimientos idénticos el mismo día (p. ej. dos
 * cargos iguales de tarjeta) son casi siempre transacciones reales distintas,
 * así que NO podemos colapsarlos con un simple "¿ya existe uno igual?".
 *
 * Regla exacta (por clave = día + monto + descripción + referencia):
 *   Sea D = cuántos movimientos con esa clave ya existen en la base de datos
 *           ANTES de esta importación,
 *   y   F = cuántas veces aparece esa clave dentro del archivo.
 *   Se importan max(0, F − D) filas y las D primeras ocurrencias se omiten
 *   como posibles duplicados.
 *
 * Consecuencias:
 *   - Archivo nuevo con 2 filas idénticas (F=2, D=0) → se importan las 2.
 *   - Re-subir exactamente el mismo archivo (F=D) → no-op: todo se omite.
 *   - El archivo trae 2 idénticas y ya había 1 de una subida anterior
 *     (F=2, D=1) → se importa 1 (la que faltaba).
 */

import type { ParsedTransaction } from "@/lib/bank-parser";

/**
 * Clave de deduplicación de un movimiento: día calendario (según el reloj
 * del servidor, igual que el rango fechaStart/fechaEnd usado en la consulta
 * a la BD) + monto + descripción + referencia. Misma regla que el módulo de
 * bancos ha usado desde que existe — sólo cambia CUÁNTAS coincidencias se
 * toleran, no la clave.
 */
export function claveDeDuplicado(tx: Pick<ParsedTransaction, "fecha" | "monto" | "descripcion" | "referencia">): string {
  const dia = new Date(tx.fecha);
  dia.setHours(0, 0, 0, 0);
  return `${dia.getTime()}|${tx.monto}|${tx.descripcion}|${tx.referencia ?? ""}`;
}

/**
 * Aplica la regla de conteo a una lista de claves (en el orden del archivo).
 *
 * @param claves   clave de duplicado de cada fila del archivo, en orden.
 * @param enBD     conteo de movimientos ya existentes en la BD por clave,
 *                 medido ANTES de insertar nada de este archivo.
 * @returns        por cada fila, `true` = importar, `false` = omitir como
 *                 posible duplicado. Se importan exactamente max(0, F − D)
 *                 filas por clave: las primeras D ocurrencias se omiten.
 */
export function planImportacion(claves: string[], enBD: (clave: string) => number): boolean[] {
  const vistas = new Map<string, number>(); // ocurrencias ya procesadas por clave
  return claves.map((clave) => {
    const n = (vistas.get(clave) ?? 0) + 1; // n-ésima ocurrencia dentro del archivo (1-based)
    vistas.set(clave, n);
    return n > Math.max(0, enBD(clave));
  });
}
