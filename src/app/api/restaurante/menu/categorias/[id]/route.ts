/**
 * PATCH /api/restaurante/menu/categorias/[id]
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const patchSchema = z.object({
  nombre: z.string().min(1).max(80).transform((v) => v.trim()).optional(),
  orden: z.number().int().optional(),
  activa: z.boolean().optional(),
});

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const categoria = await prisma.restMenuCategoria.findUnique({
      where: { id },
      select: { id: true, companyId: true },
    });
    if (!categoria) throw new AuthzError(404, "Categoría no encontrada");

    await requireWriter(categoria.companyId, req);
    await requireModule(categoria.companyId, "RESTAURANTE", req);

    if (parsed.data.nombre) {
      const dup = await prisma.restMenuCategoria.findUnique({
        where: {
          companyId_nombre: { companyId: categoria.companyId, nombre: parsed.data.nombre },
        },
        select: { id: true },
      });
      if (dup && dup.id !== id) {
        return NextResponse.json(
          { error: `Ya existe la categoría «${parsed.data.nombre}»` },
          { status: 409 }
        );
      }
    }

    const updated = await prisma.restMenuCategoria.update({
      where: { id },
      data: parsed.data,
    });
    return NextResponse.json(updated);
  }
);
