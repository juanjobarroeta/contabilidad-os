/**
 * GET    /api/construccion/rayas/[id]  — raya with trabajos + detalles
 * DELETE /api/construccion/rayas/[id]  — only if BORRADOR (prevents audit holes)
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireMembership,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

async function loadRaya(id: string, req: Request, write = false) {
  const raya = await prisma.rayaSemanal.findUnique({
    where: { id },
    select: { id: true, companyId: true, estado: true },
  });
  if (!raya) throw new AuthzError(404, "Raya no encontrada");
  if (write) await requireWriter(raya.companyId, req);
  else await requireMembership(raya.companyId, undefined, req);
  await requireModule(raya.companyId, "CONSTRUCCION_CUADRILLAS");
  return raya;
}

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    await loadRaya(id, req, false);
    const raya = await prisma.rayaSemanal.findUnique({
      where: { id },
      include: {
        cuadrilla: {
          select: {
            id: true,
            nombre: true,
            especialidad: true,
            miembros: { where: { isActive: true } },
          },
        },
        trabajos: {
          include: {
            presupuestoPartida: {
              select: {
                id: true,
                codigo: true,
                concepto: { select: { codigo: true, descripcion: true } },
              },
            },
            unidadProyecto: { select: { id: true, nombre: true, codigo: true } },
          },
        },
        detalles: { include: { miembro: true } },
        bankTransaction: true,
      },
    });
    return NextResponse.json(raya);
  }
);

export const DELETE = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const raya = await loadRaya(id, req, true);
    if (raya.estado !== "BORRADOR") {
      return NextResponse.json(
        { error: `No se puede eliminar una raya ${raya.estado}` },
        { status: 422 }
      );
    }
    await prisma.rayaSemanal.delete({ where: { id } });
    return NextResponse.json({ deleted: id });
  }
);
