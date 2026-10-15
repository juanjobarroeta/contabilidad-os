// ─────────────────────────────────────────────────────────────────────────────
// CRUCE DE COMPRAS DE FARMACIA: lo que llegó al anaquel contra lo facturado.
//
// La compra va requisición/orden → CFDI del proveedor (ligado a la orden) →
// recepción física (el lote que farmacia captura, contra la línea de la
// orden). Los renglones del CFDI se ligan al catálogo (HospCfdiLinea,
// cfdi-ligado.ts); el CFDI ya no crea kardex. Tres huecos que pasaban callados:
//   · LOTE SIN CFDI — existencia que entró sin factura: sin asiento, sin IVA
//     acreditable, sin deducción. O falta bajar el CFDI o se recibió de más.
//     Un lote recibido contra una línea de orden cuyo renglón de CFDI ya está
//     ligado SÍ tiene factura, aunque el lote no la lleve.
//   · CFDI SIN RECEPCIÓN — el proveedor facturó insumos que nadie recibió en
//     farmacia: el libro (115.01) los tiene y el anaquel no. Sale de los
//     renglones de compra (ligados o por ligar) de facturas sin lote ni
//     recepción; y, en empresas que aún dejan al CFDI crear inventario, de las
//     entradas derivadas que ningún lote adoptó.
//   · DEVOLUCIÓN AL PROVEEDOR — sale del inventario sin asiento propio: la baja
//     contable la hace la NOTA DE CRÉDITO del proveedor; si no llega, 115.01
//     queda de más. Se listan para vigilar que llegue.
// Sólo lectura. No corrige nada: cada renglón lo resuelve una persona.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { r2 } from "./util";

type Db = PrismaClient | Prisma.TransactionClient;

export interface LoteSinCfdi {
  loteId: string;
  lote: string;
  insumo: string;
  recibidoAt: Date;
  proveedor: string | null;
  cantidad: number;
  monto: number;
}

export interface CfdiSinRecepcion {
  invoiceId: string;
  referencia: string;
  fecha: Date;
  proveedor: string | null;
  renglones: number;
  /** De esos renglones, los que aún no se ligan a un insumo del catálogo. */
  porLigar: number;
  monto: number;
}

export interface DevolucionAProveedor {
  movimientoId: string;
  fecha: Date;
  insumo: string;
  lote: string | null;
  proveedor: string | null;
  cantidad: number;
  monto: number;
  motivo: string | null;
}

export interface CruceCompras {
  desde: Date;
  hasta: Date;
  lotesSinCfdi: LoteSinCfdi[];
  cfdisSinRecepcion: CfdiSinRecepcion[];
  devolucionesAProveedor: DevolucionAProveedor[];
  totales: { lotesSinCfdi: number; cfdisSinRecepcion: number; devolucionesAProveedor: number };
}

const valor = (cantidad: unknown, costo: unknown) => r2(Math.abs(Number(cantidad ?? 0)) * Number(costo ?? 0));

export async function cruceCompras(db: Db, companyId: string, desde: Date, hasta: Date): Promise<CruceCompras> {
  const [lotes, derivadas, devoluciones, renglones] = await Promise.all([
    db.hospLote.findMany({
      where: { companyId, invoiceId: null, recibidoAt: { gte: desde, lt: hasta } },
      select: {
        id: true,
        lote: true,
        recibidoAt: true,
        costoUnitario: true,
        insumo: { select: { nombre: true } },
        supplier: { select: { razonSocial: true } },
        movimientos: {
          where: { tipo: "ENTRADA_COMPRA" },
          select: {
            cantidad: true,
            costoUnitario: true,
            // ¿La línea de la orden contra la que se recibió ya tiene su renglón de CFDI?
            solicitudPartida: {
              select: { hospCfdiLineas: { where: { estado: "LIGADA", invoice: { status: { not: "CANCELLED" } } }, select: { invoiceId: true }, take: 1 } },
            },
          },
        },
      },
      orderBy: { recibidoAt: "asc" },
    }),
    // Entradas derivadas del CFDI que ningún lote adoptó, de facturas sin lote.
    db.hospMovimientoInsumo.findMany({
      where: {
        companyId,
        tipo: "ENTRADA_COMPRA",
        loteId: null,
        invoiceId: { not: null },
        fecha: { gte: desde, lt: hasta },
        invoice: { status: { not: "CANCELLED" }, hospLotes: { none: {} } },
      },
      select: {
        cantidad: true,
        costoUnitario: true,
        invoice: { select: { id: true, serie: true, folio: true, uuid: true, fecha: true, customer: { select: { razonSocial: true } }, contraparteNombre: true } },
      },
    }),
    db.hospMovimientoInsumo.findMany({
      where: { companyId, tipo: "DEVOLUCION", cantidad: { lt: 0 }, fecha: { gte: desde, lt: hasta } },
      select: {
        id: true,
        fecha: true,
        cantidad: true,
        costoUnitario: true,
        referencia: true,
        insumo: { select: { nombre: true } },
        lote: { select: { lote: true, supplier: { select: { razonSocial: true } } } },
      },
      orderBy: { fecha: "asc" },
    }),
    // Renglones de compra de facturas sin lote ni recepción con su CFDI. Uno
    // ligado a una línea de orden que ya recibió algo cuenta como recibido.
    db.hospCfdiLinea.findMany({
      where: {
        companyId,
        estado: { in: ["LIGADA", "POR_LIGAR"] },
        invoice: {
          status: { not: "CANCELLED" },
          fecha: { gte: desde, lt: hasta },
          hospLotes: { none: {} },
          hospMovimientosInsumo: { none: { tipo: "ENTRADA_COMPRA", loteId: { not: null } } },
        },
      },
      select: {
        estado: true,
        importe: true,
        solicitudPartida: { select: { cantidadRecibida: true } },
        invoice: { select: { id: true, serie: true, folio: true, uuid: true, fecha: true, customer: { select: { razonSocial: true } }, contraparteNombre: true } },
      },
    }),
  ]);

  const amparado = (l: (typeof lotes)[number]) =>
    l.movimientos.length > 0 && l.movimientos.every((m) => (m.solicitudPartida?.hospCfdiLineas.length ?? 0) > 0);
  const lotesSinCfdi: LoteSinCfdi[] = lotes.filter((l) => !amparado(l)).map((l) => {
    const cantidad = l.movimientos.reduce((s, m) => s + Number(m.cantidad), 0);
    const monto = r2(l.movimientos.reduce((s, m) => s + valor(m.cantidad, m.costoUnitario ?? l.costoUnitario), 0));
    return { loteId: l.id, lote: l.lote, insumo: l.insumo.nombre, recibidoAt: l.recibidoAt, proveedor: l.supplier?.razonSocial ?? null, cantidad: r2(cantidad), monto };
  });

  type Inv = { id: string; serie: string | null; folio: string | null; uuid: string | null; fecha: Date; customer: { razonSocial: string } | null; contraparteNombre: string | null };
  const porFactura = new Map<string, CfdiSinRecepcion>();
  const factura = (inv: Inv) => {
    const ref = [inv.serie?.trim(), inv.folio?.trim()].filter(Boolean).join("-") || inv.uuid?.slice(0, 8).toUpperCase() || inv.id;
    const f = porFactura.get(inv.id) ?? { invoiceId: inv.id, referencia: ref, fecha: inv.fecha, proveedor: inv.customer?.razonSocial ?? inv.contraparteNombre ?? null, renglones: 0, porLigar: 0, monto: 0 };
    porFactura.set(inv.id, f);
    return f;
  };
  // Una factura con ALGUNA línea de orden ya recibida no se reporta: la
  // recepción parcial es otra conversación (la orden la enseña).
  const recibidas = new Set(renglones.filter((r) => Number(r.solicitudPartida?.cantidadRecibida ?? 0) > 0).map((r) => r.invoice.id));
  for (const r of renglones) {
    if (recibidas.has(r.invoice.id)) continue;
    const f = factura(r.invoice);
    f.renglones++;
    if (r.estado === "POR_LIGAR") f.porLigar++;
    f.monto = r2(f.monto + Number(r.importe));
  }
  const conRenglones = new Set(renglones.map((r) => r.invoice.id));
  for (const m of derivadas) {
    const inv = m.invoice!;
    if (conRenglones.has(inv.id)) continue;
    const f = factura(inv);
    f.renglones++;
    f.monto = r2(f.monto + valor(m.cantidad, m.costoUnitario));
  }
  const cfdisSinRecepcion = [...porFactura.values()].sort((a, b) => a.fecha.getTime() - b.fecha.getTime());

  const devolucionesAProveedor: DevolucionAProveedor[] = devoluciones.map((d) => ({
    movimientoId: d.id,
    fecha: d.fecha,
    insumo: d.insumo.nombre,
    lote: d.lote?.lote ?? null,
    proveedor: d.lote?.supplier?.razonSocial ?? null,
    cantidad: r2(Math.abs(Number(d.cantidad))),
    monto: valor(d.cantidad, d.costoUnitario),
    motivo: d.referencia,
  }));

  const suma = (xs: Array<{ monto: number }>) => r2(xs.reduce((s, x) => s + x.monto, 0));
  return {
    desde,
    hasta,
    lotesSinCfdi,
    cfdisSinRecepcion,
    devolucionesAProveedor,
    totales: { lotesSinCfdi: suma(lotesSinCfdi), cfdisSinRecepcion: suma(cfdisSinRecepcion), devolucionesAProveedor: suma(devolucionesAProveedor) },
  };
}
