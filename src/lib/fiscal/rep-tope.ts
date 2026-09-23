// ─────────────────────────────────────────────────────────────────────────────
// TOPE POR FACTURA de lo que sus REPs mueven de IVA. PURO.
//
// Cada REP se lee por su cuenta: el IVA que declara su nodo TrasladoDR (o el
// prorrateo de la factura por lo pagado) y la retención prorrateada. Nada
// impedía que la SUMA de todos los REPs de una factura rebasara el IVA de la
// propia factura: dos REPs para el mismo pago, un REP que declara el IVA
// completo en un pago parcial, un sustituto sin cancelar el original. En CENTRO
// (ago-2026) una factura de 26,680 con IVA de 3,720 acreditó 11,160.
//
// La factura es la autoridad: lo acumulado por todos sus REPs vigentes nunca
// excede su IVA trasladado, su IVA retenido ni su ISR retenido. El mes toma
// sólo lo que le cabe después de lo que ya tomaron los meses anteriores
// (`previos`), así que el tope no mueve lo ya declarado — el exceso se corta en
// el mes en que aparece.
// ─────────────────────────────────────────────────────────────────────────────

import type { InvoiceLike } from "./iva-flujo";
import { ivaTrasladadoDe, repIvaTrasladadoDe } from "./iva-flujo";
import { isrRetenidoDe, ivaRetenidoDe, repIsrRetenidoDe, repIvaRetenidoDe } from "./iva-retenciones";

export interface LinkRep {
  impPagado: number | null;
  ivaTrasladado: number | null;
  ivaDerivado: boolean;
}

export type PadreRep = InvoiceLike & { total: number };

/** Lo que el mes puede tomar: lo suyo, sin rebasar lo que queda bajo el tope. */
export function acotarAlPadre(p: { tope: number; previo: number; enMes: number }): number {
  const disponible = Math.max(0, p.tope - Math.max(0, p.previo));
  return Math.max(0, Math.min(p.enMes, disponible));
}

export interface MontosRep {
  /** IVA trasladado de los pagos del mes (acotado). */
  iva: number;
  /** IVA retenido de los pagos del mes (acotado). */
  ivaRetenido: number;
  /** ISR retenido de los pagos del mes (acotado). */
  isrRetenido: number;
  /** ¿Se recortó algo? Para avisar: casi siempre es un REP duplicado o mal hecho. */
  recortado: boolean;
}

const suma = (links: LinkRep[], f: (l: LinkRep) => number) => links.reduce((s, l) => s + f(l), 0);

/**
 * El IVA de la factura sólo es tope si se CONOCE: con filas de IVA o con
 * `totalImpuestos`. Una factura legada sin desglose ni total de impuestos no
 * dice cuánto IVA trae, y cortar a cero lo que el REP sí declara sería peor.
 */
function ivaConocido(p: PadreRep): boolean {
  return p.taxes.some((t) => t.tipo === "IVA" && !t.retencion) || p.totalImpuestos != null;
}

/**
 * Los montos de los pagos del mes (`delMes`) a una factura PPD, acotados a lo
 * que la factura trae menos lo que tomaron sus pagos de meses anteriores.
 * Magnitudes sin signo: el llamador aplica el de la nota de crédito.
 */
export function montosRepDelPadre(parent: PadreRep, previos: LinkRep[], delMes: LinkRep[]): MontosRep {
  const ivaMes = suma(delMes, (l) => repIvaTrasladadoDe(l, parent));
  const retMes = suma(delMes, (l) => repIvaRetenidoDe(l, parent));
  const isrMes = suma(delMes, (l) => repIsrRetenidoDe(l, parent));

  const iva = ivaConocido(parent)
    ? acotarAlPadre({ tope: ivaTrasladadoDe(parent), previo: suma(previos, (l) => repIvaTrasladadoDe(l, parent)), enMes: ivaMes })
    : ivaMes;
  // Las retenciones ya se prorratean contra la factura; el tope sólo muerde
  // cuando hay pagos repetidos.
  const ivaRetenido = acotarAlPadre({ tope: ivaRetenidoDe(parent), previo: suma(previos, (l) => repIvaRetenidoDe(l, parent)), enMes: retMes });
  const isrRetenido = acotarAlPadre({ tope: isrRetenidoDe(parent), previo: suma(previos, (l) => repIsrRetenidoDe(l, parent)), enMes: isrMes });

  const recortado = iva + 0.005 < ivaMes || ivaRetenido + 0.005 < retMes || isrRetenido + 0.005 < isrMes;
  return { iva, ivaRetenido, isrRetenido, recortado };
}
