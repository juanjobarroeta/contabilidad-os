/**
 * POST /api/restaurante/ordenes/[id]/cobrar
 *
 * The RESTAURANTE money loop — charges an open order and posts it to the
 * general ledger atomically. This is the proof-flow that exercises schema +
 * auth + module gate + postings in one request.
 *
 * Body: {
 *   formaPago: "EFECTIVO" | "TRANSFERENCIA" | "TARJETA" | "CORTESIA",
 *   bankAccountId?: string,   // required for TRANSFERENCIA / TARJETA
 *   propina?: number,         // tip collected (NOT revenue → 2107 liability)
 *   fecha?: string            // ISO; defaults to now
 * }
 *
 * Atomic flow:
 *   1. totals: total = Σ non-cancelled items (IVA-incluido) → split into
 *      subtotal + iva with RestauranteConfig.ivaRate
 *   2. theoretical cost per item from recipes at CURRENT insumo avg cost;
 *      frozen on each item (costoUnitario) and the order (costoTotal)
 *   3. inventory relief: insumo.stock -= cantidad * receta.cantidad
 *   4. (bank forms) BankTransaction (CREDITO, +total+propina, MATCHED)
 *   5. postVentaRestaurante (DR caja/bancos, CR 4160 + 2102 + 2107)
 *   6. postCostoVentaRestaurante (DR 5103 / CR 1107) when costo > 0
 *   7. estado → COBRADA
 *
 * CORTESIA: no revenue posting and no BankTransaction, but the food still
 * left the kitchen — inventory is relieved and the COGS entry still posts.
 *
 * Idempotency: the ABIERTA → COBRADA state machine (409 on a double-tap).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import {
  postCostoVentaRestaurante,
  postVentaRestaurante,
} from "@/lib/accounting/postings";
import { round2, splitIvaIncluidoRest } from "@/lib/restaurante";

const bodySchema = z.object({
  formaPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "TARJETA", "CORTESIA"]),
  bankAccountId: z.string().optional(),
  propina: z.number().min(0).default(0),
  fecha: z.string().datetime().optional(),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { formaPago, bankAccountId } = parsed.data;
    const propina = round2(parsed.data.propina);
    const fecha = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date();

    const orden = await prisma.restOrden.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            menuItem: {
              select: {
                nombre: true,
                receta: {
                  select: {
                    insumoId: true,
                    cantidad: true,
                    insumo: { select: { costoPromedio: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!orden) throw new AuthzError(404, "Orden no encontrada");

    await requireWriter(orden.companyId, req);
    await requireModule(orden.companyId, "RESTAURANTE", req);

    if (orden.estado === "COBRADA") {
      return NextResponse.json({ error: "La orden ya fue cobrada" }, { status: 409 });
    }
    if (orden.estado === "CANCELADA") {
      return NextResponse.json(
        { error: "No se puede cobrar una orden cancelada" },
        { status: 422 }
      );
    }

    const vivos = orden.items.filter((i) => i.estadoCocina !== "CANCELADO");
    if (vivos.length === 0) {
      return NextResponse.json(
        { error: "La orden no tiene partidas activas" },
        { status: 422 }
      );
    }

    const total = round2(vivos.reduce((sum, i) => sum + Number(i.cantidad) * Number(i.precioUnitario), 0));
    if (formaPago !== "CORTESIA" && !(total > 0)) {
      return NextResponse.json(
        { error: "El total de la orden debe ser mayor a 0 para cobrar" },
        { status: 422 }
      );
    }

    const isBank = formaPago === "TRANSFERENCIA" || formaPago === "TARJETA";
    let bankAccount: { id: string; companyId: string } | null = null;
    if (isBank) {
      if (!bankAccountId) {
        return NextResponse.json(
          { error: "bankAccountId requerido para pago con transferencia/tarjeta" },
          { status: 400 }
        );
      }
      bankAccount = await prisma.bankAccount.findUnique({
        where: { id: bankAccountId },
        select: { id: true, companyId: true },
      });
      if (!bankAccount || bankAccount.companyId !== orden.companyId) {
        return NextResponse.json({ error: "Cuenta bancaria inválida" }, { status: 400 });
      }
    }

    const config = await prisma.restauranteConfig.findUnique({
      where: { companyId: orden.companyId },
      select: { ivaRate: true },
    });
    const ivaRate = Number(config?.ivaRate ?? 0.16);
    const { subtotal, iva } = splitIvaIncluidoRest(total, ivaRate);

    // Theoretical cost per item at current average costs + inventory relief map.
    const costoPorItem = new Map<string, number>();
    const descargas = new Map<string, number>(); // insumoId → cantidad a descargar
    let costoTotal = 0;
    for (const item of vivos) {
      const costoUnitario = round2(
        item.menuItem.receta.reduce(
          (sum, r) => sum + Number(r.cantidad) * Number(r.insumo.costoPromedio),
          0
        )
      );
      costoPorItem.set(item.id, costoUnitario);
      costoTotal += Number(item.cantidad) * costoUnitario;
      for (const r of item.menuItem.receta) {
        descargas.set(
          r.insumoId,
          (descargas.get(r.insumoId) ?? 0) + Number(item.cantidad) * Number(r.cantidad)
        );
      }
    }
    costoTotal = round2(costoTotal);

    const descripcion =
      `Orden #${orden.folio}` +
      (orden.mesa ? ` — Mesa ${orden.mesa}` : orden.tipo !== "MESA" ? ` — ${orden.tipo}` : "");

    const result = await prisma.$transaction(async (tx) => {
      let bankTxId: string | null = null;

      if (isBank && bankAccount) {
        const bankTx = await tx.bankTransaction.create({
          data: {
            companyId: orden.companyId,
            bankAccountId: bankAccount.id,
            fecha,
            descripcion,
            referencia: String(orden.folio),
            monto: Math.abs(total + propina), // positive = credit (money in)
            tipo: "CREDITO",
            status: "MATCHED",
            source: "RESTAURANTE",
            notes: `Generado por restauranteos: orden ${orden.id}`,
          },
        });
        bankTxId = bankTx.id;
      }

      if (formaPago !== "CORTESIA") {
        await postVentaRestaurante(tx, {
          companyId: orden.companyId,
          ordenId: orden.id,
          descripcion,
          subtotal,
          iva,
          propina,
          formaPago,
          fecha,
        });
      }

      // COGS + inventory relief also on CORTESIA — the food was consumed.
      if (costoTotal > 0) {
        await postCostoVentaRestaurante(tx, {
          companyId: orden.companyId,
          ordenId: orden.id,
          descripcion,
          costo: costoTotal,
          fecha,
        });
      }
      for (const [insumoId, cantidad] of descargas) {
        await tx.restInsumo.update({
          where: { id: insumoId },
          data: { stock: { decrement: cantidad } },
        });
      }
      for (const [itemId, costoUnitario] of costoPorItem) {
        await tx.restOrdenItem.update({
          where: { id: itemId },
          data: { costoUnitario },
        });
      }

      const updated = await tx.restOrden.update({
        where: { id },
        data: {
          estado: "COBRADA",
          cobradaAt: fecha,
          formaPago,
          subtotal,
          iva,
          total,
          propina,
          costoTotal,
          bankAccountId: bankAccount?.id ?? null,
          bankTransactionId: bankTxId,
        },
        include: {
          items: { include: { menuItem: { select: { id: true, nombre: true } } } },
        },
      });

      return { orden: updated, bankTransactionId: bankTxId };
    });

    return NextResponse.json(result);
  }
);
