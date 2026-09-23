// ─────────────────────────────────────────────────────────────────────────────
// QUÉ REP CUENTA. Un complemento de pago cuenta para impuestos y saldos si está
// timbrado y NO fue sustituido por otro (TipoRelacion 04).
//
// Caso real (CENTRO, ago-2026): un proveedor emitió dos REPs con el IVA de la
// factura COMPLETA en cada pago parcial y en septiembre los sustituyó por dos
// correctos sin cancelar los primeros. Los cuatro seguían «STAMPED» y el motor
// acreditó 11,160 de IVA sobre una factura que trae 3,720.
//
// Sin prisma: es sólo el filtro, para que cualquier consulta lo use igual.
// `sustituidoPorUuid` lo escribe src/lib/cfdi-sustitucion.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma } from "@prisma/client";

/** Filtro del CFDI de pago (el `pagoInvoice` de un PagoDoctoRelacionado) que cuenta. */
export const REP_VIGENTE = {
  tipo: "PAGO",
  status: "STAMPED",
  sustituidoPorUuid: null,
} as const satisfies Prisma.InvoiceWhereInput;
