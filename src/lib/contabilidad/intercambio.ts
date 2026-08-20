/**
 * FASE 2g — el intercambio: la unidad que se vende AL COSTO.
 *
 * El contador tiene una serie completa por familia para «intercambio» (4131 de
 * venta, 5131 de costo, 27 subcuentas cada una) y el motor no la usaba nunca:
 * todo caía en 4101/5101. No es poca cosa — $735.5M declarados en 4131 entre
 * 2023-01 y 2026-06, el 35% de la venta de unidades de 2025.
 *
 * Qué es realmente. No es la permuta con un cliente: la balanza lo dice sola.
 * Mes con mes el abono de 4131 y el cargo de 5131 son el MISMO importe —
 * $158,954,544 contra $158,954,535 en marzo de 2025, nueve pesos de diferencia
 * sobre ciento cincuenta y nueve millones. Un intercambio entre distribuidores
 * se mueve a costo: el otro concesionario tiene la unidad que tu cliente quiere
 * y se la cambias por una tuya, sin margen para ninguno.
 *
 * Por eso la señal es el MARGEN, no el catálogo ni la serie del folio: una venta
 * de unidad cuyo precio iguala su costo es un intercambio. Contrastado contra la
 * CE mes a mes desde 2024-10 con tolerancia de ±0.2%: $754.3M derivados contra
 * $735.5M declarados —103%— y el mes a mes sigue la forma (enero 2025 $97.2M
 * contra $101.1M, junio 2026 $15.3M contra $15.1M). Aflojar la tolerancia a ±2%
 * apenas mueve la aguja ($766.6M): el grupo está pegado al cero, no repartido a
 * lo largo de una curva, que es justo lo que uno espera de una operación
 * definida por no tener margen.
 *
 * Lo que NO se dedujo, con su razón:
 * - Flotilla (4141): la CE declara $4.1M en todo 2025. La regla natural —tres o
 *   más unidades del mismo modelo al mismo cliente en el mes— atrapa $1,272.6M.
 *   Sobra por trescientos a uno: aquí vender varias unidades iguales al mismo
 *   cliente es lo normal, no una flotilla. Sin señal, no se clasifica.
 * - Seminuevos (4291/5291): la venta se identifica bien, pero el contador la
 *   parte en AFECTOS y NO AFECTOS y esa distinción no está en el CFDI — el IVA
 *   trasladado da la proporción al revés ($36.1M con IVA contra $12.8M
 *   declarados como afectos). Es una pregunta de una línea para el contador.
 */

/** ±0.2%: el grupo está pegado al cero, no repartido en una curva. */
export const TOLERANCIA_AL_COSTO = 0.002;

/**
 * ¿Esta venta de unidad se hizo al costo? Sin precio o sin costo la respuesta
 * es NO: una unidad sin costeo no es un intercambio, es un dato incompleto, y
 * mandarla a 4131 escondería el hueco.
 */
export function esVentaAlCosto(
  precio: number,
  costo: number,
  tolerancia: number = TOLERANCIA_AL_COSTO,
): boolean {
  if (!(precio > 0.005) || !(costo > 0.005)) return false;
  return Math.abs(1 - costo / precio) < tolerancia;
}
