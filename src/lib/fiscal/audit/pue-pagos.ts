// ─────────────────────────────────────────────────────────────────────────────
// PUE acreditado sin pago conciliado. El motor asume que un CFDI PUE se pagó al
// emitirse; cuando la empresa concilia banco podemos cruzarlo y detectar PUE
// cuyo IVA se acreditó sin que el pago aparezca en el banco. Emite UN hallazgo
// agregado (poco ruido); el detalle CFDI-por-CFDI vive en Papeles → IVA.
// ─────────────────────────────────────────────────────────────────────────────

import type { Hallazgo } from "./types";

export interface PueSinPago {
  invoiceId: string;
  total: number;
  ivaAcreditable: number;
}

const fmt = (n: number) =>
  "$" + n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** One aggregate Hallazgo for all unpaid-PUE in scope (empty list → no finding). */
export function auditarPagosPue(items: PueSinPago[], ejercicio: number): Hallazgo[] {
  if (items.length === 0) return [];
  const totalIva = items.reduce((s, i) => s + i.ivaAcreditable, 0);
  return [
    {
      checkClave: "iva.pue.sin_pago",
      severidad: "warn",
      mensaje: `${items.length} CFDI(s) PUE del ejercicio ${ejercicio} con IVA acreditable (${fmt(totalIva)}) sin pago conciliado en banco.`,
      referencias: items.map((i) => i.invoiceId),
      fundamento: { ley: "LIVA", articulo: "5", fraccion: "I" },
      sugerencia:
        "El IVA sólo es acreditable si el gasto se pagó efectivamente. Revisa estos CFDIs en Papeles → IVA acreditable: concilia el pago en Bancos o, si no se pagó, exclúyelos del acreditamiento.",
    },
  ];
}
