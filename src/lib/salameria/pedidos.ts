/**
 * Armado y recálculo de un pedido — compartido por el mostrador (ERP) y por el
 * carrito de la tienda, para que el mismo producto cueste lo mismo por los dos
 * caminos. Duplicar esta lógica en las dos superficies es cómo un pedido
 * tomado por teléfono termina con otro precio que el mismo pedido en línea.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { costoEnvio, resolverPrecio, totalesPedido } from "./precios";

type Tx = Prisma.TransactionClient | PrismaClient;

export type PartidaPedida = {
  productoId: string;
  cantidad: number;
};

export type PartidaResuelta = {
  productoId: string;
  nombre: string;
  cantidad: number;
  precio: number;
  precioLista: number | null;
  ivaTasa: number | null;
  importe: number;
  esPreventa: boolean;
  /** Unidades disponibles hoy. Un preventa vende sin stock a propósito. */
  disponible: number;
  /** El producto no se puede vender: sin precio, inactivo o sin existencia. */
  problema: string | null;
};

/**
 * Resuelve precio, IVA y disponibilidad de cada partida contra la lista que le
 * toca al comprador. No escribe nada: es la función que la tienda usa para
 * pintar el carrito y el checkout usa para congelar los precios.
 */
export async function resolverPartidas(
  db: Tx,
  args: {
    companyId: string;
    /** null = menudeo (lo que ve quien no inició sesión). */
    listaId: string | null;
    partidas: PartidaPedida[];
  }
): Promise<PartidaResuelta[]> {
  const ids = [...new Set(args.partidas.map((p) => p.productoId))];
  if (ids.length === 0) return [];

  const [productos, listas, renglones] = await Promise.all([
    db.salProducto.findMany({
      where: { id: { in: ids }, companyId: args.companyId },
      select: {
        id: true,
        nombre: true,
        ivaTasa: true,
        activo: true,
        publicado: true,
        preventa: true,
        stock: true,
      },
    }),
    db.salListaPrecio.findMany({
      where: {
        companyId: args.companyId,
        activa: true,
        OR: [{ publica: true }, ...(args.listaId ? [{ id: args.listaId }] : [])],
      },
      select: { id: true, descuento: true, publica: true },
    }),
    db.salPrecio.findMany({
      where: {
        productoId: { in: ids },
        lista: {
          companyId: args.companyId,
          activa: true,
          OR: [{ publica: true }, ...(args.listaId ? [{ id: args.listaId }] : [])],
        },
      },
      select: { listaId: true, productoId: true, precio: true, minimo: true },
    }),
  ]);

  const porId = new Map(productos.map((p) => [p.id, p]));
  const publica = listas.find((l) => l.publica) ?? null;
  const cliente = args.listaId ? (listas.find((l) => l.id === args.listaId) ?? null) : null;

  const renglonesNum = renglones.map((r) => ({
    listaId: r.listaId,
    productoId: r.productoId,
    precio: Number(r.precio),
    minimo: Number(r.minimo),
  }));

  return args.partidas.map((p) => {
    const prod = porId.get(p.productoId);
    if (!prod) {
      return {
        productoId: p.productoId,
        nombre: "(producto no encontrado)",
        cantidad: p.cantidad,
        precio: 0,
        precioLista: null,
        ivaTasa: null,
        importe: 0,
        esPreventa: false,
        disponible: 0,
        problema: "El producto ya no existe",
      };
    }

    const r = resolverPrecio({
      productoId: p.productoId,
      cantidad: p.cantidad,
      renglones: renglonesNum,
      listaPublica: publica
        ? { id: publica.id, descuento: Number(publica.descuento), publica: true }
        : null,
      listaCliente: cliente
        ? { id: cliente.id, descuento: Number(cliente.descuento), publica: cliente.publica }
        : null,
    });

    const disponible = Number(prod.stock);
    // Orden de los problemas: primero lo que no se puede arreglar subiendo la
    // cantidad. Enseñar «sin stock» de algo que además no tiene precio manda al
    // usuario a resolver lo que no era.
    const problema = !prod.activo
      ? "Producto dado de baja"
      : r.origen === "SIN_PRECIO"
        ? "Sin precio en la lista"
        : // Un preventa vende sin existencia: ésa es toda la idea del PRE ORDER.
          !prod.preventa && disponible < p.cantidad
          ? `Sólo quedan ${disponible}`
          : null;

    return {
      productoId: p.productoId,
      nombre: prod.nombre,
      cantidad: p.cantidad,
      precio: r.precio,
      precioLista: r.precioLista,
      ivaTasa: prod.ivaTasa == null ? null : Number(prod.ivaTasa),
      importe: Math.round(p.cantidad * r.precio * 100) / 100,
      esPreventa: prod.preventa,
      disponible,
      problema,
    };
  });
}

/**
 * Recalcula los totales de un pedido desde sus partidas guardadas y la regla de
 * envío de la empresa. Los precios de las partidas NO se vuelven a resolver:
 * están congelados desde que se agregaron, y una lista que cambie mañana no
 * debe reescribir lo que el cliente ya vio.
 */
export async function recalcularPedido(db: Tx, pedidoId: string) {
  const pedido = await db.salPedido.findUnique({
    where: { id: pedidoId },
    include: {
      partidas: {
        include: { producto: { select: { ivaTasa: true } } },
      },
    },
  });
  if (!pedido) throw new Error("Pedido no encontrado");

  const cfg = await db.salConfig.findUnique({
    where: { companyId: pedido.companyId },
    select: { envioUmbral: true, envioTarifa: true, envioTarifaBase: true },
  });

  const partidas = pedido.partidas.map((p) => ({
    productoId: p.productoId,
    cantidad: Number(p.cantidad),
    precio: Number(p.precio),
    ivaTasa: p.ivaTasa == null ? null : Number(p.ivaTasa),
  }));

  const subtotalBruto =
    Math.round(partidas.reduce((a, p) => a + p.cantidad * p.precio, 0) * 100) / 100;

  const envio = costoEnvio({
    subtotal: subtotalBruto,
    umbral: Number(cfg?.envioUmbral ?? 0),
    tarifa: Number(cfg?.envioTarifa ?? 0),
    tarifaBase: Number(cfg?.envioTarifaBase ?? 0),
    recogeEnTienda: pedido.recogeEnTienda,
  });

  const t = totalesPedido({
    partidas,
    envio,
    descuento: Number(pedido.descuento),
  });

  const esPreventa = pedido.partidas.some((p) => p.esPreventa);

  return db.salPedido.update({
    where: { id: pedidoId },
    data: {
      subtotal: t.subtotal,
      envio: t.envio,
      iva: t.iva,
      total: t.total,
      esPreventa,
    },
    include: {
      partidas: {
        include: {
          producto: {
            select: { id: true, sku: true, nombre: true, slug: true, imagenes: true },
          },
        },
      },
    },
  });
}

/** El anticipo que exige un pedido de preventa (0 si no hay preventa). */
export function anticipoRequerido(args: {
  total: number;
  esPreventa: boolean;
  porcentaje: number;
}): number {
  if (!args.esPreventa || !(args.porcentaje > 0)) return 0;
  return Math.round(args.total * args.porcentaje * 100) / 100;
}
