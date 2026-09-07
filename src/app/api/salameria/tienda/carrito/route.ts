/**
 * GET /api/salameria/tienda/carrito
 * PUT /api/salameria/tienda/carrito   body: { partidas: [{ productoId, cantidad }] }
 *
 * El carrito del comprador con sesión. Es un `SalPedido` en estado CARRITO —
 * una fila, no una tabla aparte— para que al pagar no haya que copiar nada de
 * una estructura a otra: cambia el estado y ya es pedido.
 *
 * EL PUT MANDA EL CARRITO COMPLETO, no un delta. Un carrito es una lista corta
 * que el navegador ya tiene entera, y los deltas («+1 de esto») se pierden o se
 * duplican cuando el usuario da dos veces al botón con mala señal.
 *
 * Los precios se resuelven EN CADA PUT contra la lista del comprador: mientras
 * es carrito, el precio es el de hoy. Se congelan al hacer checkout.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, withAuthz } from "@/lib/authz";
import { requireSalCuenta } from "@/lib/salameria/tienda";
import { conFolioUnico, siguienteFolio } from "@/lib/salameria/folio";
import { recalcularPedido, resolverPartidas } from "@/lib/salameria/pedidos";

const INCLUDE_CARRITO = {
  partidas: {
    include: {
      producto: {
        select: {
          id: true,
          sku: true,
          nombre: true,
          slug: true,
          imagenes: true,
          presentacion: true,
          preventa: true,
          fechaLlegada: true,
        },
      },
    },
  },
} as const;

async function carritoDe(companyId: string, cuentaId: string) {
  return prisma.salPedido.findFirst({
    where: { companyId, cuentaId, estado: "CARRITO" },
    include: INCLUDE_CARRITO,
    orderBy: { createdAt: "desc" },
  });
}

export const GET = withAuthz(async (req: Request) => {
  const ctx = await requireSalCuenta(req);
  const carrito = await carritoDe(ctx.companyId, ctx.cuentaId);
  return NextResponse.json(carrito ?? { partidas: [], total: 0, vacio: true });
});

const putSchema = z.object({
  partidas: z
    .array(
      z.object({
        productoId: z.string().min(1),
        cantidad: z.number().positive().max(9999),
      })
    )
    .max(100),
  recogeEnTienda: z.boolean().optional(),
});

export const PUT = withAuthz(async (req: Request) => {
  const ctx = await requireSalCuenta(req);
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const resueltas = await resolverPartidas(prisma, {
    companyId: ctx.companyId,
    listaId: ctx.listaId,
    partidas: parsed.data.partidas,
  });

  // Los problemas NO bloquean el PUT: el carrito los muestra («sólo quedan 3»)
  // para que el comprador ajuste. Quien bloquea es el checkout.
  const vendibles = resueltas.filter((r) => r.problema === null);

  const carrito = await prisma.$transaction(async (tx) => {
    const existente = await tx.salPedido.findFirst({
      where: { companyId: ctx.companyId, cuentaId: ctx.cuentaId, estado: "CARRITO" },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });

    const id =
      existente?.id ??
      (
        await conFolioUnico(async () =>
          tx.salPedido.create({
            data: {
              companyId: ctx.companyId,
              folio: await siguienteFolio(tx, ctx.companyId, "pedido"),
              estado: "CARRITO",
              origen: "TIENDA",
              cuentaId: ctx.cuentaId,
              customerId: ctx.customerId,
            },
            select: { id: true },
          })
        )
      ).id;

    if (parsed.data.recogeEnTienda !== undefined) {
      await tx.salPedido.update({
        where: { id },
        data: { recogeEnTienda: parsed.data.recogeEnTienda },
      });
    }

    // Reemplazo completo: es lo que hace que el PUT sea idempotente.
    await tx.salPedidoPartida.deleteMany({ where: { pedidoId: id } });
    if (vendibles.length) {
      await tx.salPedidoPartida.createMany({
        data: vendibles.map((r) => ({
          pedidoId: id,
          productoId: r.productoId,
          cantidad: r.cantidad,
          precio: r.precio,
          ivaTasa: r.ivaTasa,
          importe: r.importe,
          nombreCongelado: r.nombre,
          esPreventa: r.esPreventa,
        })),
      });
    }

    await recalcularPedido(tx, id);
    return tx.salPedido.findUnique({ where: { id }, include: INCLUDE_CARRITO });
  });

  if (!carrito) throw new AuthzError(500, "No se pudo armar el carrito");

  return NextResponse.json({
    ...carrito,
    // Lo que quedó fuera y por qué — el carrito lo pinta como aviso.
    rechazadas: resueltas
      .filter((r) => r.problema !== null)
      .map((r) => ({ productoId: r.productoId, nombre: r.nombre, problema: r.problema })),
  });
});
