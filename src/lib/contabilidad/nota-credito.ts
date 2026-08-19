/**
 * Comprobantes de EGRESO emitidos y recibidos (CFDI tipoSat "E").
 *
 * Un comprobante de egreso no registra una operación nueva: corrige una
 * anterior. El SAT lo usa para tres cosas que en el libro significan lo mismo
 * —deshacer lo ya registrado—: la nota de crédito (TipoRelacion 01), la
 * devolución de mercancía (03) y, la más voluminosa en un distribuidor, la
 * APLICACIÓN DE ANTICIPO (07). En el procedimiento del Apéndice 6 de la guía
 * de llenado, el anticipo se factura completo, después la operación total se
 * factura completa otra vez, y la nota de egreso resta el anticipo para que el
 * ingreso no quede duplicado. Es el egreso —no la factura— lo que evita el
 * doble conteo.
 *
 * Por eso el asiento derivado es el ESPEJO exacto del que haría el mismo
 * comprobante como "I": las mismas cuentas, con cargos y abonos invertidos.
 * Tratar un egreso como si fuera ingreso no sólo yerra el signo — deja el
 * anticipo contado dos veces, con su IVA y su cargo a clientes.
 *
 * Medido en MARGOM (2026-08-18, ventana 2023-01…2026-06 de la CE): 15,660
 * notas emitidas por $628.3M abonados a ingresos donde correspondía cargarlos
 * —un vuelco de $1,256.5M— contra una divergencia total del grupo 4 frente a
 * la balanza declarada de $1,288.5M. Es casi toda la diferencia. Del lado
 * recibido, 1,353 notas por $59.3M cargadas a gasto en vez de acreditadas.
 */
export type TipoMovimiento = "CARGO" | "ABONO";

/** ¿El CFDI es de tipo egreso (nota de crédito, devolución o aplicación de anticipo)? */
export function esComprobanteDeEgreso(inv: { tipoSat?: string | null }): boolean {
  return (inv.tipoSat ?? "").trim().toUpperCase() === "E";
}

/**
 * Invierte el movimiento cuando el comprobante es de egreso. Con `false`
 * devuelve el mismo tipo: los flujos que no distinguen quedan intactos.
 */
export function espejo(tipo: TipoMovimiento, esEgreso: boolean): TipoMovimiento {
  if (!esEgreso) return tipo;
  return tipo === "CARGO" ? "ABONO" : "CARGO";
}

/**
 * Signo para los flujos que acumulan importes con signo (previews del estado
 * de resultados) en vez de pares cargo/abono.
 */
export function signoDeComprobante(esEgreso: boolean): 1 | -1 {
  return esEgreso ? -1 : 1;
}
