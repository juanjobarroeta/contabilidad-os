// ─────────────────────────────────────────────────────────────────────────────
// IVA RETENIDO A PROVEEDORES (Art. 1-A LIVA) — helpers PUROS compartidos por el
// motor mensual (src/lib/impuestos.ts) y el papel de trabajo (/api/papeles/iva).
//
// Dos reglas que antes no estaban en el cálculo:
//
// 1. ACREDITAMIENTO DIFERIDO (Art. 5, fracc. IV LIVA). El IVA que nosotros
//    retuvimos a un proveedor NO es acreditable en el mes de la operación:
//    sólo lo es "en la declaración de pago mensual siguiente a la declaración
//    en la que se haya efectuado el entero de la retención". Así que el IVA
//    acreditable del mes es el trasladado MENOS lo retenido, y lo retenido del
//    mes anterior (ya enterado) entra al acreditable de este mes.
//
// 2. ENTERO. Lo retenido es un pasivo propio que se paga al SAT junto con la
//    declaración del mes (Art. 1-A, penúltimo párrafo): NO reduce nuestro IVA a
//    cargo, pero SÍ es dinero que sale. El papel lo muestra como línea aparte y
//    en el total a pagar.
//
// La obligación de retener nace al PAGAR (flujo, Art. 1-A último párrafo), por
// eso PUE retiene al emitirse y PPD retiene con cada pago del REP, prorrateado.
// ─────────────────────────────────────────────────────────────────────────────

import type { InvoiceLike } from "./iva-flujo";
import { ivaTrasladadoDe } from "./iva-flujo";

/** IVA retenido (filas de impuesto IVA con retencion=true) de una factura. */
export function ivaRetenidoDe(inv: InvoiceLike): number {
  return inv.taxes.filter((t) => t.tipo === "IVA" && t.retencion).reduce((s, t) => s + t.importe, 0);
}

/**
 * ISR retenido a un proveedor persona física (10% honorarios Art. 106,
 * arrendamiento Art. 116 LISR): también se entera con la declaración del mes.
 */
export function isrRetenidoDe(inv: InvoiceLike): number {
  return inv.taxes.filter((t) => t.tipo === "ISR" && t.retencion).reduce((s, t) => s + t.importe, 0);
}

/** ISR retenido que corresponde a UN pago de REP sobre una factura PPD (prorrateo). */
export function repIsrRetenidoDe(
  link: { impPagado: number | null },
  parent: InvoiceLike & { total: number },
): number {
  const ret = isrRetenidoDe(parent);
  if (ret <= 0 || parent.total <= 0 || link.impPagado == null) return 0;
  return ret * Math.min(1, link.impPagado / parent.total);
}

/**
 * IVA acreditable NETO del mes de la operación: trasladado menos retenido
 * (Art. 5-IV). Nunca negativo: una retención mayor al trasladado es un dato
 * anómalo (ver `revisarRetencionIva`), no un crédito negativo.
 */
export function ivaAcreditableNetoDe(inv: InvoiceLike): number {
  return Math.max(0, ivaTrasladadoDe(inv) - ivaRetenidoDe(inv));
}

/**
 * IVA retenido que corresponde a UN pago de REP sobre una factura PPD:
 * prorrateo por lo pagado (el REP no desglosa retenciones por pago).
 */
export function repIvaRetenidoDe(
  link: { impPagado: number | null },
  parent: InvoiceLike & { total: number },
): number {
  const ret = ivaRetenidoDe(parent);
  if (ret <= 0 || parent.total <= 0 || link.impPagado == null) return 0;
  return ret * Math.min(1, link.impPagado / parent.total);
}

/** Tasa máxima legal de retención de IVA sobre la base: el 16% completo (Art. 1-A). */
export const TASA_MAX_RETENCION_IVA = 0.16;

export type RevisionRetencion = { revisar: false } | { revisar: true; motivo: string };

/**
 * ¿La retención de este CFDI es sospechosa? Dos señales, ambas imposibles en
 * una retención legítima del Art. 1-A:
 *   - retenido > IVA trasladado del propio CFDI (no se puede retener más IVA
 *     del que se trasladó);
 *   - retenido > 16% de la base (la retención máxima es el 100% del IVA, que
 *     es el 16% de la base; las usuales son 2/3 ≈ 10.67% y 4%).
 * Caso real: un CFDI de comisión bancaria de $0.01 con $0.01 de "retención"
 * (100% de la base): redondeo o XML mal armado, nunca una retención que
 * debamos enterar. Se MARCA, no se excluye: decide el contador.
 */
export function revisarRetencionIva(input: {
  subtotal: number;
  trasladado: number;
  retenido: number;
}): RevisionRetencion {
  const { subtotal, trasladado, retenido } = input;
  if (retenido <= 0) return { revisar: false };
  if (retenido > trasladado + 0.005) {
    return { revisar: true, motivo: "La retención supera el IVA trasladado del propio CFDI." };
  }
  if (subtotal > 0 && retenido / subtotal > TASA_MAX_RETENCION_IVA + 0.005) {
    return { revisar: true, motivo: "La retención supera el 16% de la base, máximo legal (Art. 1-A LIVA)." };
  }
  return { revisar: false };
}
