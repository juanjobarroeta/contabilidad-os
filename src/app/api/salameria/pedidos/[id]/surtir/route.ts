/**
 * POST /api/salameria/pedidos/[id]/surtir
 *
 * El pedido sale del almacén. Todo en UNA transacción:
 *
 *   1. Toma lotes por caducidad (FEFO) para cada partida.
 *   2. Guarda en la partida QUÉ lotes salieron (`lotesSurtidos`) y a qué costo
 *      — el rastro que contesta una alerta sanitaria y el que hace auditable
 *      el costo de venta.
 *   3. Escribe el kardex (un renglón por lote) y recalcula el espejo.
 *   4. Postea DR 5120 Costo de mercancía vendida / CR 1108 Almacén.
 *
 * SURTIR NO ES COBRAR. Aquí sólo se reconoce el COSTO; el ingreso se reconoce
 * al entregar (POST …/pagar con `entregar`). Separarlos es lo que permite que
 * una preventa cobrada en marzo no se convierta en ingreso hasta que la
 * mercancía llega en junio.
 *
 * Un pedido con partidas de PREVENTA no se surte hasta que el producto deja de
 * ser preventa (llegó el contenedor): se responde 409 con cuáles faltan.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { salidaPorPedido, StockInsuficiente } from "@/lib/salameria/inventario";
import { postCostoVentaSalameria } from "@/lib/accounting/postings";

const schema = z.object({ fecha: z.coerce.date().optional() });

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const parsed = schema.safeParse((await req.json().catch(() => null)) ?? {});
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const pedido = await prisma.salPedido.findUnique({
      where: { id },
      include: {
        partidas: {
          include: { producto: { select: { id: true, sku: true, nombre: true, preventa: true } } },
        },
      },
    });
    if (!pedido) throw new AuthzError(404, "Pedido no encontrado");

    await requireWriter(pedido.companyId, req);
    await requireModule(pedido.companyId, "SALAMERIA", req);

    if (pedido.estado === "CARRITO") {
      return NextResponse.json(
        { error: "Es un carrito sin confirmar, no un pedido" },
        { status: 409 }
      );
    }
    if (pedido.estado === "CANCELADO") {
      return NextResponse.json({ error: "El pedido está cancelado" }, { status: 409 });
    }
    if (pedido.surtidoAt) {
      return NextResponse.json({ error: "Este pedido ya fue surtido" }, { status: 409 });
    }

    // La preventa se resuelve sola cuando la importación llega y alguien apaga
    // la bandera del producto; hasta entonces surtirla sería vender aire.
    const enPreventa = pedido.partidas.filter((p) => p.producto.preventa);
    if (enPreventa.length) {
      return NextResponse.json(
        {
          error: "Hay partidas en preventa: la mercancía todavía no llega",
          partidas: enPreventa.map((p) => ({
            productoId: p.productoId,
            nombre: p.producto.nombre,
          })),
        },
        { status: 409 }
      );
    }

    const fecha = parsed.data.fecha ?? new Date();

    try {
      const resultado = await prisma.$transaction(async (tx) => {
        const vigente = await tx.salPedido.findUnique({
          where: { id },
          select: { surtidoAt: true, estado: true },
        });
        if (vigente?.surtidoAt) {
          throw new AuthzError(409, "Este pedido ya fue surtido");
        }

        let costoTotal = 0;

        for (const partida of pedido.partidas) {
          const salida = await salidaPorPedido(tx, {
            companyId: pedido.companyId,
            productoId: partida.productoId,
            cantidad: Number(partida.cantidad),
            pedidoId: pedido.id,
            fecha,
          });

          await tx.salPedidoPartida.update({
            where: { id: partida.id },
            data: {
              lotesSurtidos: salida.lotes.map((l) => ({
                loteId: l.loteId,
                codigo: l.codigo,
                caducidad: l.caducidad,
                cantidad: l.cantidad,
                costoUnitario: l.costoUnitario,
              })),
              costoUnitario: salida.costoUnitario,
            },
          });

          costoTotal = Math.round((costoTotal + salida.costoTotal) * 100) / 100;
        }

        // Costo cero (mercancía de muestra, lotes sin costo) no genera asiento:
        // postear un importe de 0 rompe el balanceo.
        if (costoTotal > 0) {
          await postCostoVentaSalameria(tx, {
            companyId: pedido.companyId,
            pedidoId: pedido.id,
            descripcion: `Pedido ${pedido.folio}`,
            costo: costoTotal,
            fecha,
          });
        }

        const actualizado = await tx.salPedido.update({
          where: { id },
          data: { estado: "SURTIDO", surtidoAt: fecha },
          include: { partidas: true },
        });

        return { pedido: actualizado, costoTotal };
      });

      return NextResponse.json(resultado);
    } catch (e) {
      if (e instanceof StockInsuficiente) {
        return NextResponse.json(
          { error: e.message, productoId: e.productoId },
          { status: 409 }
        );
      }
      throw e;
    }
  }
);
