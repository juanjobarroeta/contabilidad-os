/**
 * PATCH /api/restaurante/insumos/[id]
 *
 * Edit an insumo. `stock` and `costoPromedio` are accepted here as MANUAL
 * corrections (inventario físico / ajuste de costo) — the normal path for
 * both is receiving compras and charging órdenes.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const patchSchema = z.object({
  nombre: z.string().min(1).max(120).transform((v) => v.trim()).optional(),
  categoria: z.string().max(60).nullable().optional(),
  unidad: z.enum(["KG", "G", "L", "ML", "PZA"]).optional(),
  costoPromedio: z.number().min(0).optional(),
  stock: z.number().optional(),
  stockMinimo: z.number().min(0).optional(),
  activo: z.boolean().optional(),
});

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const insumo = await prisma.restInsumo.findUnique({
      where: { id },
      select: { id: true, companyId: true },
    });
    if (!insumo) throw new AuthzError(404, "Insumo no encontrado");

    await requireWriter(insumo.companyId, req);
    await requireModule(insumo.companyId, "RESTAURANTE", req);

    if (parsed.data.nombre) {
      const dup = await prisma.restInsumo.findUnique({
        where: {
          companyId_nombre: { companyId: insumo.companyId, nombre: parsed.data.nombre },
        },
        select: { id: true },
      });
      if (dup && dup.id !== id) {
        return NextResponse.json(
          { error: `Ya existe un insumo llamado «${parsed.data.nombre}»` },
          { status: 409 }
        );
      }
    }

    const updated = await prisma.restInsumo.update({ where: { id }, data: parsed.data });
    return NextResponse.json(updated);
  }
);
