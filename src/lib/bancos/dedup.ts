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

/**
 * Variante con HORA (formato "pegado" del portal, que trae "13:07:00" en la
 * línea de fecha). La regla F − D por día no distingue "re-pegado del mismo
 * movimiento" de "segundo movimiento idéntico" cuando los pegados son
 * PARCIALES (el usuario copia sólo lo nuevo del portal): dos SPEI de $10,000
 * el mismo día, pegados en momentos distintos, y el segundo se omitía como
 * duplicado. La hora identifica al movimiento dentro del día y rompe el
 * empate.
 *
 * Regla por fila, en orden del archivo:
 *   1. Sin hora → regla clásica F − D sobre la clave del día.
 *   2. Con hora → si la BD ya tiene esa (clave, hora), es un re-pegado: se
 *      omite (con conteo F − D por si el portal imprime dos movimientos con
 *      la MISMA hora exacta).
 *   3. Si no, se descuenta del pool de renglones LEGADO de la clave (los
 *      guardados antes de que existiera la hora, referencia NULL): cubren
 *      re-pegados de movimientos viejos sin re-importarlos.
 *   4. Agotado el pool, es un movimiento nuevo: se importa.
 *
 * Nota: si un día tiene renglones legado Y el pegado es parcial, el pool
 * puede omitir un movimiento realmente nuevo — re-pegar el día completo lo
 * corrige (los legado se consumen en orden y el faltante entra). Hacia
 * adelante todo se guarda con hora y la ambigüedad desaparece.
 */
export function planImportacionConHora(
  filas: { clave: string; hora: string | null }[],
  enBD: (clave: string) => number,
  enBDConHora: (clave: string, hora: string) => number,
): boolean[] {
  const vistasSinHora = new Map<string, number>();
  const vistasConHora = new Map<string, number>();
  const legadoUsado = new Map<string, number>();
  return filas.map(({ clave, hora }) => {
    if (!hora) {
      const n = (vistasSinHora.get(clave) ?? 0) + 1;
      vistasSinHora.set(clave, n);
      return n > Math.max(0, enBD(clave));
    }
    const kh = `${clave}|${hora}`;
    const n = (vistasConHora.get(kh) ?? 0) + 1;
    vistasConHora.set(kh, n);
    if (n <= Math.max(0, enBDConHora(clave, hora))) return false;
    const usado = legadoUsado.get(clave) ?? 0;
    if (usado < Math.max(0, enBD(clave))) {
      legadoUsado.set(clave, usado + 1);
      return false;
    }
    return true;
  });
}
