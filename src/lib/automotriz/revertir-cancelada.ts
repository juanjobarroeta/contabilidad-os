// ─────────────────────────────────────────────────────────────────────────────
// REVERSIÓN DE LO DERIVADO CUANDO UN CFDI SE CANCELA
//
// Cancelar un CFDI hacía UNA sola cosa: `Invoice.status = CANCELLED`. El motor
// fiscal sobrevive porque filtra por status al leer, pero la capa de operación
// NO lee facturas: MATERIALIZA filas —unidades, costos, movimientos de kardex,
// órdenes de servicio, nómina— y ningún filtro deshace una fila ya escrita.
//
// El resultado medido en MARGOM: 3,695 CFDIs de ingreso cancelados y 4 de
// egreso, con todo lo que derivaron intacto. Una compra cancelada deja la
// unidad en el piso con su costo; una venta cancelada deja la unidad marcada
// vendida y su precio contado como ingreso.
//
// Esto lo repara. Es IDEMPOTENTE (correrlo dos veces no hace nada la segunda) y
// NO BORRA UNIDADES a propósito:
//
//   • Si se canceló la COMPRA, se le quita el costo y la liga, pero la unidad
//     se queda. Casi siempre la cancelación es por refacturación, y el CFDI
//     nuevo vuelve a derivarla con el costo correcto; borrar la fila perdería
//     el VIN, su expediente y cualquier costo capturado a mano.
//   • Si se canceló la VENTA, la unidad vuelve a DISPONIBLE — mismo criterio
//     que la reparación de auto-vehiculo.ts cuando una factura deja de
//     calificar como venta.
//   • Los VehiculoCosto capturados A MANO se CONSERVAN (`autoCreado: false`).
//     Nadie tecleó un costo para que una cancelación se lo lleve.
//
// El expediente del VIN (VehiculoCfdi) no se toca: es historia, y saber que una
// factura cancelada mencionó esta unidad es justo lo que se quiere auditar.
// ─────────────────────────────────────────────────────────────────────────────

import type { PrismaClient } from "@prisma/client";

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface ReversionCancelada {
  invoiceId: string;
  /** Unidades cuya COMPRA amparaba este CFDI: pierden costo y liga. */
  compras: { unidades: number; costoLiberado: number };
  /** Unidades cuya VENTA amparaba este CFDI: vuelven a piso. */
  ventas: { unidades: number; ingresoLiberado: number };
  /** VehiculoCosto derivados de este CFDI. Los manuales se conservan. */
  costos: { borrados: number; monto: number; conservadosManuales: number };
  refacciones: { movimientos: number };
  servicios: { borrados: number };
  nomina: { borrados: number };
  /** true si algo cambió — sirve para no reportar reversiones vacías. */
  huboCambios: boolean;
}

/**
 * Deshace todo lo que la capa de operación derivó de un CFDI, para usarse en el
 * momento en que se descubre que el SAT lo tiene cancelado.
 *
 * Todo va en una transacción: una reversión a medias es peor que ninguna —
 * dejaría la unidad sin costo pero con sus gastos colgando.
 */
export async function revertirDerivadosDeCancelada(
  db: PrismaClient,
  invoiceId: string,
): Promise<ReversionCancelada> {
  // Se lee ANTES de escribir para poder reportar cuánto dinero se liberó; sin
  // esto la reversión es invisible y nadie puede cuadrar el antes con el después.
  const [comprasAntes, ventasAntes, costosAntes] = await Promise.all([
    db.vehiculo.findMany({
      where: { compraInvoiceId: invoiceId },
      select: { id: true, costoCompra: true },
    }),
    db.vehiculo.findMany({
      where: { ventaInvoiceId: invoiceId },
      select: { id: true, precioVenta: true },
    }),
    db.vehiculoCosto.findMany({
      where: { invoiceId },
      select: { id: true, monto: true, autoCreado: true },
    }),
  ]);

  const costosDerivados = costosAntes.filter((c) => c.autoCreado);
  const costosManuales = costosAntes.length - costosDerivados.length;

  const res: ReversionCancelada = {
    invoiceId,
    compras: {
      unidades: comprasAntes.length,
      costoLiberado: r2(comprasAntes.reduce((s, v) => s + v.costoCompra, 0)),
    },
    ventas: {
      unidades: ventasAntes.length,
      ingresoLiberado: r2(ventasAntes.reduce((s, v) => s + (v.precioVenta ?? 0), 0)),
    },
    costos: {
      borrados: costosDerivados.length,
      monto: r2(costosDerivados.reduce((s, c) => s + c.monto, 0)),
      conservadosManuales: costosManuales,
    },
    refacciones: { movimientos: 0 },
    servicios: { borrados: 0 },
    nomina: { borrados: 0 },
    huboCambios: false,
  };

  await db.$transaction(async (tx) => {
    // ── Venta cancelada → la unidad vuelve al piso ───────────────────────────
    if (ventasAntes.length > 0) {
      await tx.vehiculo.updateMany({
        where: { ventaInvoiceId: invoiceId },
        data: {
          estado: "DISPONIBLE",
          ventaInvoiceId: null,
          precioVenta: null,
          fechaVenta: null,
          clienteId: null,
        },
      });
    }

    // ── Compra cancelada → la unidad se queda, sin costo y sin liga ──────────
    // costoCompra a 0 la deja visible como «sin costo», que es la verdad: no
    // hay documento que respalde su costo. Si fue refacturación, el CFDI nuevo
    // la vuelve a derivar.
    if (comprasAntes.length > 0) {
      await tx.vehiculo.updateMany({
        where: { compraInvoiceId: invoiceId },
        data: { compraInvoiceId: null, costoCompra: 0 },
      });
    }

    // ── Costos derivados del CFDI ────────────────────────────────────────────
    if (costosDerivados.length > 0) {
      await tx.vehiculoCosto.deleteMany({
        where: { invoiceId, autoCreado: true },
      });
    }

    // ── Kardex de refacciones ────────────────────────────────────────────────
    // La existencia NO está materializada (se deriva de los movimientos), así
    // que borrar el movimiento devuelve el stock solo. `Refaccion.ultimoCosto`
    // queda con el último costo visto y no se recalcula: es un caché de
    // presentación, no un saldo, y la siguiente entrada lo corrige.
    const movs = await tx.refaccionMovimiento.deleteMany({ where: { invoiceId } });
    res.refacciones.movimientos = movs.count;

    // ── Orden de servicio facturada ──────────────────────────────────────────
    const servs = await tx.servicioVenta.deleteMany({ where: { invoiceId } });
    res.servicios.borrados = servs.count;

    // ── Nómina ───────────────────────────────────────────────────────────────
    // Un recibo de nómina cancelado deja de ser costo de mano de obra; si no se
    // borra, la absorción del taller sigue cargando un sueldo que no se pagó.
    const nom = await tx.nominaCosto.deleteMany({ where: { invoiceId } });
    res.nomina.borrados = nom.count;
  });

  res.huboCambios =
    res.compras.unidades > 0 ||
    res.ventas.unidades > 0 ||
    res.costos.borrados > 0 ||
    res.refacciones.movimientos > 0 ||
    res.servicios.borrados > 0 ||
    res.nomina.borrados > 0;

  return res;
}

/**
 * Facturas ya marcadas CANCELLED que TODAVÍA tienen efectos derivados vivos —
 * la deuda que dejó el defecto histórico. Se consulta por existencia en cada
 * tabla derivada en vez de recorrer todas las canceladas: en MARGOM son 3,699
 * canceladas y sólo un puñado tocan inventario.
 */
export async function canceladasConEfectosVivos(
  db: PrismaClient,
  companyId: string,
  limit = 500,
): Promise<string[]> {
  const filas = await db.invoice.findMany({
    where: {
      companyId,
      status: "CANCELLED",
      OR: [
        { vehiculosComprados: { some: {} } },
        { vehiculosVendidos: { some: {} } },
        { vehiculoCostos: { some: {} } },
        { refaccionMovimientos: { some: {} } },
        { servicioVenta: { isNot: null } },
        { nominaCosto: { isNot: null } },
      ],
    },
    select: { id: true },
    orderBy: { fecha: "asc" },
    take: limit,
  });
  return filas.map((f) => f.id);
}
