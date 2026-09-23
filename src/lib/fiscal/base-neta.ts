// ─────────────────────────────────────────────────────────────────────────────
// BASE NETA DE DESCUENTO: el valor de un CFDI para ISR (y para cualquier base
// que no salga de las filas de impuesto) es SubTotal − Descuento.
//
// Es lo que hace la forma del SAT: el precargado de la declaración mensual
// suma «SUBTOTAL – DESCUENTO» (acuse de agosto 2026 de CENTRO: 39,846 de
// descuentos en facturas emitidas del mes). El motor sumaba el subtotal bruto,
// así que en toda factura con descuento inflaba ingresos y deducciones. El IVA
// no cambia: sale de las filas de impuesto, cuya Base ya viene neta.
//
// OJO con la nómina: en un CFDI de nómina el Descuento son las DEDUCCIONES del
// trabajador (ISR, IMSS…), no una rebaja del precio. Estas funciones son para
// comprobantes de ingreso/egreso; la nómina conserva su subtotal.
// ─────────────────────────────────────────────────────────────────────────────

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** SubTotal − Descuento de un comprobante (nunca negativo). */
export function baseNeta(subtotal: unknown, descuento: unknown): number {
  return Math.max(0, num(subtotal) - num(descuento));
}

/** Lo mismo sobre un `_sum` de prisma que pidió `{ subtotal: true, descuento: true }`. */
export function sumaNeta(sum: { subtotal?: unknown; descuento?: unknown } | null | undefined): number {
  return num(sum?.subtotal) - num(sum?.descuento);
}

/**
 * La parte de un pago (REP) que corresponde a base: el pago trae importes con
 * impuestos, y el Total del comprobante ya viene neto del descuento
 * (Total = SubTotal − Descuento + traslados − retenciones), así que la base
 * cobrada es impPagado × (SubTotal − Descuento) / Total.
 */
export function basePagada(impPagado: number, p: { subtotal: unknown; descuento?: unknown; total: unknown }): number {
  const total = num(p.total);
  if (total <= 0) return 0;
  return impPagado * (baseNeta(p.subtotal, p.descuento) / total);
}
