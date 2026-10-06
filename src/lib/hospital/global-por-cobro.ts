// ─────────────────────────────────────────────────────────────────────────────
// Cargos a la factura global por un cobro SIN CFDI.
//
// Un cobro SIN_CFDI no es ingreso «no declarado»: es un cobro cuyo comprobante
// es la factura global a público en general. Al capturarlo, los cargos libres
// de su episodio se marcan `publicoGeneral` —con el id del cobro, para poder
// deshacerlo— y la global del mes los recoge (facturacion.ts). Mientras no
// estén timbrados, el motor fiscal los suma igual (ingresos-sin-cfdi.ts).
//
// Las condiciones de «libre» viven aquí y facturacion.ts las importa: una sola
// definición de qué cargo puede ir a una prefactura o a la global.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/** Condición de BD equivalente a «libre»: sin CFDI vigente ni prefactura pendiente. */
export const SIN_CFDI_VIGENTE = { OR: [{ invoiceId: null }, { invoice: { is: { status: "CANCELLED" as const } } }] };
export const SIN_PREFACTURA_PENDIENTE = { OR: [{ prefacturaId: null }, { prefactura: { is: { status: { not: "PENDIENTE" } } } }] };

/**
 * Manda a la global los cargos LIBRES del episodio (sin CFDI vigente, sin
 * prefactura pendiente, sin marcar ya). Idempotente: lo ya marcado no se toca.
 */
export async function marcarGlobalPorCobro(db: Db, companyId: string, episodioId: string, cobroId: string): Promise<number> {
  const r = await db.hospCargo.updateMany({
    where: {
      episodioId,
      episodio: { companyId },
      cancelado: false,
      publicoGeneral: false,
      AND: [SIN_CFDI_VIGENTE, SIN_PREFACTURA_PENDIENTE],
    },
    data: { publicoGeneral: true, publicoGeneralCobroId: cobroId },
  });
  return r.count;
}

/**
 * Deshace lo que marcó el cobro (al cancelarse): sólo sus cargos y sólo los
 * que siguen libres. Si ya entraron a una global timbrada o a una prefactura,
 * se quedan: ese CFDI ya existe y deshacerlo es trabajo de facturación.
 */
export async function liberarGlobalPorCobro(db: Db, cobroId: string): Promise<number> {
  const r = await db.hospCargo.updateMany({
    where: { publicoGeneralCobroId: cobroId, publicoGeneral: true, AND: [SIN_CFDI_VIGENTE, SIN_PREFACTURA_PENDIENTE] },
    data: { publicoGeneral: false, publicoGeneralCobroId: null },
  });
  return r.count;
}
