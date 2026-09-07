/**
 * Almacén por lotes — entradas, salidas FEFO y el kardex que las explica.
 *
 * POR QUÉ LOTES Y NO UN SALDO POR PRODUCTO. Un importador de alimentos tiene
 * dos datos que un saldo único no puede llevar: el COSTO (la misma caja compró
 * a 18.20 el dólar en marzo y a 20.40 en agosto) y la CADUCIDAD. Con un
 * promedio, el margen de cada venta es una aproximación y «¿qué se me vence en
 * noviembre?» no tiene respuesta. Con lotes, las dos preguntas son una consulta.
 *
 * FEFO, NO FIFO. Sale primero lo que primero VENCE, no lo que primero entró.
 * En abarrote son casi siempre lo mismo, pero no cuando llega un lote de
 * remate con caducidad corta: ese tiene que salir antes que el que ya estaba,
 * o se convierte en merma. Los lotes sin caducidad van al final (no urgen).
 */

import type { Prisma, PrismaClient } from "@prisma/client";

type Tx = Prisma.TransactionClient | PrismaClient;

/** Redondeo a los 6 decimales de las columnas Decimal(18,6). */
function r6(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

export type LoteSurtido = {
  loteId: string;
  codigo: string | null;
  caducidad: Date | null;
  cantidad: number;
  costoUnitario: number;
  costoTotal: number;
};

export class StockInsuficiente extends Error {
  constructor(
    readonly productoId: string,
    readonly pedida: number,
    readonly disponible: number
  ) {
    super(
      `Stock insuficiente: se piden ${pedida} y hay ${disponible}`
    );
    this.name = "StockInsuficiente";
  }
}

/**
 * Descuenta `cantidad` del producto tomando lotes por caducidad (FEFO) y
 * devuelve de qué lotes salió y a qué costo. NO escribe el kardex ni recalcula
 * el espejo — de eso se encarga `salidaPorPedido`, que compone las tres cosas
 * en una sola transacción.
 *
 * Lanza `StockInsuficiente` si no alcanza. No se permite stock negativo: en un
 * negocio de lotes, un saldo negativo no es «capturaste tarde», es un lote que
 * no existe, y con él un costo de venta inventado.
 */
export async function tomarLotesFefo(
  tx: Tx,
  args: { companyId: string; productoId: string; cantidad: number }
): Promise<LoteSurtido[]> {
  const { companyId, productoId } = args;
  const pedida = r6(args.cantidad);
  if (!(pedida > 0)) return [];

  const lotes = await tx.salLote.findMany({
    where: { companyId, productoId, cantidad: { gt: 0 } },
    // Postgres ordena NULLS LAST en ASC por default, que es justo lo que
    // queremos: primero lo que vence, y lo sin fecha al final.
    orderBy: [{ caducidad: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      codigo: true,
      caducidad: true,
      cantidad: true,
      costoUnitario: true,
    },
  });

  const disponible = r6(lotes.reduce((a, l) => a + Number(l.cantidad), 0));
  if (disponible < pedida) {
    throw new StockInsuficiente(productoId, pedida, disponible);
  }

  const surtido: LoteSurtido[] = [];
  let falta = pedida;

  for (const lote of lotes) {
    if (falta <= 0) break;
    const hay = Number(lote.cantidad);
    const toma = r6(Math.min(hay, falta));
    if (!(toma > 0)) continue;

    const costoUnitario = Number(lote.costoUnitario);
    surtido.push({
      loteId: lote.id,
      codigo: lote.codigo,
      caducidad: lote.caducidad,
      cantidad: toma,
      costoUnitario,
      costoTotal: r6(toma * costoUnitario),
    });

    await tx.salLote.update({
      where: { id: lote.id },
      data: { cantidad: r6(hay - toma) },
    });

    falta = r6(falta - toma);
  }

  return surtido;
}

/**
 * Recalcula el espejo del producto (`stock` y `costoPromedio`) desde sus lotes.
 * Se llama después de CADA movimiento: el espejo existe para listar rápido, y
 * un espejo que se desfasa es peor que no tenerlo.
 */
export async function recalcularEspejo(
  tx: Tx,
  productoId: string
): Promise<{ stock: number; costoPromedio: number }> {
  const lotes = await tx.salLote.findMany({
    where: { productoId, cantidad: { gt: 0 } },
    select: { cantidad: true, costoUnitario: true },
  });

  const stock = r6(lotes.reduce((a, l) => a + Number(l.cantidad), 0));
  const valor = r6(
    lotes.reduce((a, l) => a + Number(l.cantidad) * Number(l.costoUnitario), 0)
  );
  const costoPromedio = stock > 0 ? r6(valor / stock) : 0;

  await tx.salProducto.update({
    where: { id: productoId },
    data: { stock, costoPromedio },
  });

  return { stock, costoPromedio };
}

export type MovimientoInput = {
  companyId: string;
  productoId: string;
  loteId?: string | null;
  tipo:
    | "ENTRADA_IMPORTACION"
    | "ENTRADA_COMPRA"
    | "ENTRADA_DEVOLUCION"
    | "SALIDA_PEDIDO"
    | "SALIDA_MERMA"
    | "SALIDA_CADUCIDAD"
    | "AJUSTE";
  /** CON SIGNO: positivo entra, negativo sale. */
  cantidad: number;
  costoUnitario?: number;
  fecha?: Date;
  referencia?: string | null;
  referenciaTipo?: string | null;
  nota?: string | null;
  usuarioId?: string | null;
};

/** Escribe un renglón del kardex. Nunca se edita ni se borra uno existente. */
export async function registrarMovimiento(tx: Tx, mov: MovimientoInput) {
  return tx.salMovimiento.create({
    data: {
      companyId: mov.companyId,
      productoId: mov.productoId,
      loteId: mov.loteId ?? null,
      tipo: mov.tipo,
      cantidad: r6(mov.cantidad),
      costoUnitario: r6(mov.costoUnitario ?? 0),
      fecha: mov.fecha ?? new Date(),
      referencia: mov.referencia ?? null,
      referenciaTipo: mov.referenciaTipo ?? null,
      nota: mov.nota ?? null,
      usuarioId: mov.usuarioId ?? null,
    },
  });
}

/**
 * Entrada de mercancía: crea el lote, escribe el kardex y actualiza el espejo.
 * Es el único camino por el que nace inventario, venga de importación o de
 * compra nacional.
 */
export async function entrarLote(
  tx: Tx,
  args: {
    companyId: string;
    productoId: string;
    cantidad: number;
    costoUnitario: number;
    codigo?: string | null;
    caducidad?: Date | null;
    importacionId?: string | null;
    compraId?: string | null;
    tipo: "ENTRADA_IMPORTACION" | "ENTRADA_COMPRA" | "ENTRADA_DEVOLUCION";
    referencia?: string | null;
    referenciaTipo?: string | null;
    fecha?: Date;
    usuarioId?: string | null;
  }
) {
  const cantidad = r6(args.cantidad);
  const costoUnitario = r6(args.costoUnitario);

  const lote = await tx.salLote.create({
    data: {
      companyId: args.companyId,
      productoId: args.productoId,
      codigo: args.codigo ?? null,
      caducidad: args.caducidad ?? null,
      cantidadInicial: cantidad,
      cantidad,
      costoUnitario,
      importacionId: args.importacionId ?? null,
      compraId: args.compraId ?? null,
    },
  });

  await registrarMovimiento(tx, {
    companyId: args.companyId,
    productoId: args.productoId,
    loteId: lote.id,
    tipo: args.tipo,
    cantidad,
    costoUnitario,
    fecha: args.fecha,
    referencia: args.referencia,
    referenciaTipo: args.referenciaTipo,
    usuarioId: args.usuarioId,
  });

  await recalcularEspejo(tx, args.productoId);
  return lote;
}

/**
 * Salida por pedido: toma lotes FEFO, escribe un renglón de kardex POR LOTE
 * (para que el rastro sirva en una alerta sanitaria del fabricante) y devuelve
 * el costo total de la partida.
 */
export async function salidaPorPedido(
  tx: Tx,
  args: {
    companyId: string;
    productoId: string;
    cantidad: number;
    pedidoId: string;
    fecha?: Date;
    usuarioId?: string | null;
  }
): Promise<{ lotes: LoteSurtido[]; costoTotal: number; costoUnitario: number }> {
  const lotes = await tomarLotesFefo(tx, {
    companyId: args.companyId,
    productoId: args.productoId,
    cantidad: args.cantidad,
  });

  for (const l of lotes) {
    await registrarMovimiento(tx, {
      companyId: args.companyId,
      productoId: args.productoId,
      loteId: l.loteId,
      tipo: "SALIDA_PEDIDO",
      cantidad: -l.cantidad,
      costoUnitario: l.costoUnitario,
      fecha: args.fecha,
      referencia: args.pedidoId,
      referenciaTipo: "SAL_PEDIDO",
      usuarioId: args.usuarioId,
    });
  }

  await recalcularEspejo(tx, args.productoId);

  const costoTotal = r6(lotes.reduce((a, l) => a + l.costoTotal, 0));
  const cantidad = r6(lotes.reduce((a, l) => a + l.cantidad, 0));
  return {
    lotes,
    costoTotal,
    costoUnitario: cantidad > 0 ? r6(costoTotal / cantidad) : 0,
  };
}

/**
 * Baja de un lote por merma o caducidad. A diferencia de la salida por pedido,
 * aquí el lote se elige a mano: se da de baja EL lote que se echó a perder.
 */
export async function bajaDeLote(
  tx: Tx,
  args: {
    companyId: string;
    loteId: string;
    cantidad: number;
    tipo: "SALIDA_MERMA" | "SALIDA_CADUCIDAD";
    nota?: string | null;
    fecha?: Date;
    usuarioId?: string | null;
  }
): Promise<{ costo: number; movimientoId: string; productoId: string }> {
  const lote = await tx.salLote.findFirst({
    where: { id: args.loteId, companyId: args.companyId },
    select: { id: true, productoId: true, cantidad: true, costoUnitario: true },
  });
  if (!lote) throw new Error("Lote no encontrado");

  const hay = Number(lote.cantidad);
  const baja = r6(args.cantidad);
  if (!(baja > 0)) throw new Error("La cantidad debe ser mayor a cero");
  if (baja > hay) {
    throw new StockInsuficiente(lote.productoId, baja, hay);
  }

  const costoUnitario = Number(lote.costoUnitario);

  await tx.salLote.update({
    where: { id: lote.id },
    data: { cantidad: r6(hay - baja) },
  });

  const mov = await registrarMovimiento(tx, {
    companyId: args.companyId,
    productoId: lote.productoId,
    loteId: lote.id,
    tipo: args.tipo,
    cantidad: -baja,
    costoUnitario,
    fecha: args.fecha,
    referencia: lote.id,
    referenciaTipo: "SAL_LOTE",
    nota: args.nota,
    usuarioId: args.usuarioId,
  });

  await recalcularEspejo(tx, lote.productoId);

  return {
    costo: r6(baja * costoUnitario),
    movimientoId: mov.id,
    productoId: lote.productoId,
  };
}

/**
 * Devuelve los lotes al almacén cuando se cancela un pedido ya surtido.
 * Vuelven a SU lote original —no a uno nuevo— para no partir la trazabilidad
 * ni inventar un costo distinto al que salió.
 */
export async function devolverLotes(
  tx: Tx,
  args: {
    companyId: string;
    productoId: string;
    lotes: Array<{ loteId: string; cantidad: number; costoUnitario: number }>;
    pedidoId: string;
    fecha?: Date;
    usuarioId?: string | null;
  }
): Promise<number> {
  let costo = 0;

  for (const l of args.lotes) {
    const lote = await tx.salLote.findFirst({
      where: { id: l.loteId, companyId: args.companyId },
      select: { id: true, cantidad: true },
    });
    // Un lote borrado (o de otra empresa) no bloquea la cancelación: se
    // registra el movimiento sin lote para que el kardex no mienta sobre el
    // total, y el ajuste queda visible en «Movimientos sin lote».
    if (lote) {
      await tx.salLote.update({
        where: { id: lote.id },
        data: { cantidad: r6(Number(lote.cantidad) + l.cantidad) },
      });
    }

    await registrarMovimiento(tx, {
      companyId: args.companyId,
      productoId: args.productoId,
      loteId: lote?.id ?? null,
      tipo: "ENTRADA_DEVOLUCION",
      cantidad: r6(l.cantidad),
      costoUnitario: l.costoUnitario,
      fecha: args.fecha,
      referencia: args.pedidoId,
      referenciaTipo: "SAL_PEDIDO_CANCELADO",
      usuarioId: args.usuarioId,
    });

    costo = r6(costo + l.cantidad * l.costoUnitario);
  }

  await recalcularEspejo(tx, args.productoId);
  return costo;
}
