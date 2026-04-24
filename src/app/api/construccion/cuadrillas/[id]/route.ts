/**
 * PUT    /api/construccion/cuadrillas/[id]  — edit metadata
 * DELETE /api/construccion/cuadrillas/[id]  — soft delete (isActive=false).
 *                                              Hard delete blocked if rayas exist.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

const putSchema = z.object({
  nombre: z.string().min(1).max(120).optional(),
  especialidad: z.string().min(1).max(40).optional(),
  jefeNombre: z.string().max(80).nullable().optional(),
  notas: z.string().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
});

async function loadAndGuard(id: string, req: Request) {
  const cuadrilla = await prisma.cuadrilla.findUnique({
    where: { id },
    select: { id: true, companyId: true },
  });
  if (!cuadrilla) throw new AuthzError(404, "Cuadrilla no encontrada");
  await requireWriter(cuadrilla.companyId, req);
  await requireModule(cuadrilla.companyId, "CONSTRUCCION_CUADRILLAS");
  return cuadrilla;
}

export const PUT = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    await loadAndGuard(id, req);
    const updated = await prisma.cuadrilla.update({
      where: { id },
      data: parsed.data,
      include: { miembros: true },
    });
    return NextResponse.json(updated);
  }
);

export const DELETE = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    await loadAndGuard(id, req);
    const rayaCount = await prisma.rayaSemanal.count({ where: { cuadrillaId: id } });
    if (rayaCount > 0) {
      // Soft delete — preserve rayas for audit
      await prisma.cuadrilla.update({
        where: { id },
        data: { isActive: false },
      });
      return NextResponse.json({ deactivated: id, rayas: rayaCount });
    }
    // No rayas — hard delete is safe (cascades miembros)
    await prisma.cuadrilla.delete({ where: { id } });
    return NextResponse.json({ deleted: id });
  }
);
