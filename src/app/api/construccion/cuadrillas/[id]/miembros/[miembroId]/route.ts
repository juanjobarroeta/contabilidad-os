/**
 * PUT    /api/construccion/cuadrillas/[id]/miembros/[miembroId]
 * DELETE /api/construccion/cuadrillas/[id]/miembros/[miembroId]
 *
 * Soft delete if the miembro has any raya detalles — preserve history.
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
  employeeId: z.string().min(1).nullable().optional(),
  rolEnCuadrilla: z.string().max(40).nullable().optional(),
  isActive: z.boolean().optional(),
});

async function loadAndGuard(
  cuadrillaId: string,
  miembroId: string,
  req: Request
) {
  const miembro = await prisma.cuadrillaMiembro.findUnique({
    where: { id: miembroId },
    select: {
      id: true,
      cuadrillaId: true,
      cuadrilla: { select: { companyId: true } },
    },
  });
  if (!miembro || miembro.cuadrillaId !== cuadrillaId) {
    throw new AuthzError(404, "Miembro no encontrado");
  }
  await requireWriter(miembro.cuadrilla.companyId, req);
  await requireModule(miembro.cuadrilla.companyId, "CONSTRUCCION_CUADRILLAS");
  return miembro;
}

export const PUT = withAuthz(
  async (
    req: Request,
    ctx: { params: Promise<{ id: string; miembroId: string }> }
  ) => {
    const { id, miembroId } = await ctx.params;
    await loadAndGuard(id, miembroId, req);
    const body = await req.json().catch(() => ({}));
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const updated = await prisma.cuadrillaMiembro.update({
      where: { id: miembroId },
      data: parsed.data,
    });
    return NextResponse.json(updated);
  }
);

export const DELETE = withAuthz(
  async (
    req: Request,
    ctx: { params: Promise<{ id: string; miembroId: string }> }
  ) => {
    const { id, miembroId } = await ctx.params;
    await loadAndGuard(id, miembroId, req);
    const histCount = await prisma.rayaDetalleMiembro.count({
      where: { miembroId },
    });
    if (histCount > 0) {
      await prisma.cuadrillaMiembro.update({
        where: { id: miembroId },
        data: { isActive: false },
      });
      return NextResponse.json({ deactivated: miembroId, historial: histCount });
    }
    await prisma.cuadrillaMiembro.delete({ where: { id: miembroId } });
    return NextResponse.json({ deleted: miembroId });
  }
);
