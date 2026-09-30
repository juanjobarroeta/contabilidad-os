// ─────────────────────────────────────────────────────────────────────────────
// CRUCE DE COMPRAS DE FARMACIA: lo que llegó al anaquel contra lo facturado.
//
// El hospital no tiene orden de compra: la compra ES el CFDI del proveedor, y
// la recepción física es el lote que farmacia captura. Nada los cruzaba, así
// que dos huecos pasaban callados:
//   · LOTE SIN CFDI — existencia que entró sin factura: sin asiento, sin IVA
//     acreditable, sin deducción. O falta bajar el CFDI o se recibió de más.
//   · CFDI SIN RECEPCIÓN — el proveedor facturó insumos que nadie recibió en
//     farmacia: el libro (115.01) los tiene y el anaquel no.
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
  const [lotes, derivadas, devoluciones] = await Promise.all([
    db.hospLote.findMany({
      where: { companyId, invoiceId: null, recibidoAt: { gte: desde, lt: hasta } },
      select: {
        id: true,
        lote: true,
        recibidoAt: true,
        costoUnitario: true,
        insumo: { select: { nombre: true } },
        supplier: { select: { razonSocial: true } },
        movimientos: { where: { tipo: "ENTRADA_COMPRA" }, select: { cantidad: true, costoUnitario: true } },
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
  ]);

  const lotesSinCfdi: LoteSinCfdi[] = lotes.map((l) => {
    const cantidad = l.movimientos.reduce((s, m) => s + Number(m.cantidad), 0);
    const monto = r2(l.movimientos.reduce((s, m) => s + valor(m.cantidad, m.costoUnitario ?? l.costoUnitario), 0));
    return { loteId: l.id, lote: l.lote, insumo: l.insumo.nombre, recibidoAt: l.recibidoAt, proveedor: l.supplier?.razonSocial ?? null, cantidad: r2(cantidad), monto };
  });

  const porFactura = new Map<string, CfdiSinRecepcion>();
  for (const m of derivadas) {
    const inv = m.invoice!;
    const ref = [inv.serie?.trim(), inv.folio?.trim()].filter(Boolean).join("-") || inv.uuid?.slice(0, 8).toUpperCase() || inv.id;
    const f = porFactura.get(inv.id) ?? { invoiceId: inv.id, referencia: ref, fecha: inv.fecha, proveedor: inv.customer?.razonSocial ?? inv.contraparteNombre ?? null, renglones: 0, monto: 0 };
    f.renglones++;
    f.monto = r2(f.monto + valor(m.cantidad, m.costoUnitario));
    porFactura.set(inv.id, f);
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
