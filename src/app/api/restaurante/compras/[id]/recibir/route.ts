/**
 * POST /api/restaurante/compras/[id]/recibir
 *
 * Goods received. Atomic flow:
 *   1. per item: stock += cantidad and costoPromedio = weighted average
 *      ((stock*costo + qty*costoUnitario) / (stock+qty); a non-positive
 *      previous stock resets the average to the incoming cost)
 *   2. post DR 1107 Almacén (+ DR 1118 IVA acreditable when iva > 0)
 *      / CR 2104 Acreedores — see postCompraRestauranteRecibida
 *   3. estado → RECIBIDA
 *
 * Body: { fecha?: string }
 * Idempotency: the estado state machine — only BORRADOR/ORDENADA can be
 * received, so a double-tap can't double-post.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { postCompraRestauranteRecibida } from "@/lib/accounting/postings";

const bodySchema = z.object({ fecha: z.string().datetime().optional() });

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const fecha = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date();

    const compra = await prisma.restCompra.findUnique({
      where: { id },
      include: {
        supplier: { select: { razonSocial: true } },
        items: { include: { insumo: { select: { id: true, stock: true, costoPromedio: true } } } },
      },
    });
    if (!compra) throw new AuthzError(404, "Compra no encontrada");

    await requireWriter(compra.companyId, req);
    await requireModule(compra.companyId, "RESTAURANTE", req);

    if (compra.estado !== "BORRADOR" && compra.estado !== "ORDENADA") {
      return NextResponse.json(
        { error: `Sólo se pueden recibir compras BORRADOR/ORDENADA (estado actual: ${compra.estado})` },
        { status: 422 }
      );
    }
    if (compra.items.length === 0) {
      return NextResponse.json({ error: "La compra no tiene partidas" }, { status: 422 });
    }

    const updated = await prisma.$transaction(async (tx) => {
      for (const item of compra.items) {
        const prevStock = item.insumo.stock;
        const prevCosto = item.insumo.costoPromedio;
        const newStock = prevStock + item.cantidad;
        // Promedio ponderado; con stock previo <= 0 el promedio se reinicia
        // al costo entrante (evita promedios sin sentido tras faltantes).
        const newCosto =
          prevStock > 0 && newStock > 0
            ? (prevStock * prevCosto + item.cantidad * item.costoUnitario) / newStock
            : item.costoUnitario;

        await tx.restInsumo.update({
          where: { id: item.insumoId },
          data: { stock: newStock, costoPromedio: Math.round(newCosto * 10000) / 10000 },
        });
      }

      if (compra.subtotal > 0) {
        await postCompraRestauranteRecibida(tx, {
          companyId: compra.companyId,
          compraId: compra.id,
          folio: compra.folio,
          subtotal: compra.subtotal,
          iva: compra.iva,
          fecha,
          proveedorNombre: compra.supplier?.razonSocial,
        });
      }

      return tx.restCompra.update({
        where: { id },
        data: { estado: "RECIBIDA", recibidaAt: fecha },
        include: {
          supplier: { select: { id: true, razonSocial: true } },
          items: { include: { insumo: { select: { id: true, nombre: true, unidad: true } } } },
        },
      });
    });

    return NextResponse.json(updated);
  }
);
