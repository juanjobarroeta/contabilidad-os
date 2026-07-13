/**
 * GET   /api/restaurante/compras/[id]
 * PATCH /api/restaurante/compras/[id]
 *
 * PATCH edits are only allowed while the compra is BORRADOR / ORDENADA
 * (before it hits inventory + ledger). Replacing `items` recomputes the
 * subtotal. `estado` accepts ORDENADA (confirm a draft) and CANCELADA.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const round2 = (n: number) => Math.round(n * 100) / 100;

const include = {
  supplier: { select: { id: true, razonSocial: true, rfc: true } },
  items: { include: { insumo: { select: { id: true, nombre: true, unidad: true } } } },
} as const;

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const compra = await prisma.restCompra.findUnique({ where: { id }, include });
    if (!compra) throw new AuthzError(404, "Compra no encontrada");

    await requireMembership(compra.companyId, undefined, req);
    await requireModule(compra.companyId, "RESTAURANTE", req);

    return NextResponse.json(compra);
  }
);

const itemSchema = z.object({
  insumoId: z.string().min(1),
  cantidad: z.number().positive(),
  costoUnitario: z.number().min(0),
});

const patchSchema = z.object({
  supplierId: z.string().nullable().optional(),
  fecha: z.string().datetime().optional(),
  iva: z.number().min(0).optional(),
  notas: z.string().max(1000).nullable().optional(),
  estado: z.enum(["ORDENADA", "CANCELADA"]).optional(),
  items: z.array(itemSchema).min(1).optional(),
});

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const compra = await prisma.restCompra.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true },
    });
    if (!compra) throw new AuthzError(404, "Compra no encontrada");

    await requireWriter(compra.companyId, req);
    await requireModule(compra.companyId, "RESTAURANTE", req);

    if (compra.estado !== "BORRADOR" && compra.estado !== "ORDENADA") {
      return NextResponse.json(
        { error: `Una compra ${compra.estado} ya no se puede modificar` },
        { status: 422 }
      );
    }

    const { items, supplierId, ...rest } = parsed.data;

    if (supplierId) {
      const supplier = await prisma.supplier.findUnique({
        where: { id: supplierId },
        select: { companyId: true },
      });
      if (!supplier || supplier.companyId !== compra.companyId) {
        return NextResponse.json({ error: "Proveedor inválido" }, { status: 400 });
      }
    }

    if (items) {
      const insumoIds = [...new Set(items.map((i) => i.insumoId))];
      const insumos = await prisma.restInsumo.findMany({
        where: { id: { in: insumoIds }, companyId: compra.companyId },
        select: { id: true },
      });
      if (insumos.length !== insumoIds.length) {
        return NextResponse.json({ error: "Insumo inválido en la compra" }, { status: 400 });
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (items) {
        await tx.restCompraItem.deleteMany({ where: { compraId: id } });
        await tx.restCompraItem.createMany({
          data: items.map((i) => ({
            compraId: id,
            insumoId: i.insumoId,
            cantidad: i.cantidad,
            costoUnitario: i.costoUnitario,
            importe: round2(i.cantidad * i.costoUnitario),
          })),
        });
      }
      return tx.restCompra.update({
        where: { id },
        data: {
          ...(supplierId !== undefined ? { supplierId } : {}),
          ...(rest.fecha ? { fecha: new Date(rest.fecha) } : {}),
          ...(rest.iva !== undefined ? { iva: round2(rest.iva) } : {}),
          ...(rest.notas !== undefined ? { notas: rest.notas } : {}),
          ...(rest.estado ? { estado: rest.estado } : {}),
          ...(items
            ? {
                subtotal: round2(
                  items.reduce((sum, i) => sum + i.cantidad * i.costoUnitario, 0)
                ),
              }
            : {}),
        },
        include,
      });
    });

    return NextResponse.json(updated);
  }
);
