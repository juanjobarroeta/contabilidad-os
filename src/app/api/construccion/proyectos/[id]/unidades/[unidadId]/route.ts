/**
 * PUT    /api/construccion/proyectos/[id]/unidades/[unidadId]
 * DELETE /api/construccion/proyectos/[id]/unidades/[unidadId]
 *
 * Edit metadata of a unidad. DELETE cascades to descendants via
 * `onDelete: Cascade` on the self-FK (be careful — deleting a Torre
 * deletes every Depto under it).
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
  tipo: z.string().max(40).nullable().optional(),
  codigo: z.string().max(40).nullable().optional(),
  parentId: z.string().min(1).nullable().optional(),
  orden: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

async function loadAndGuard(id: string, unidadId: string, req: Request) {
  const unidad = await prisma.unidadProyecto.findUnique({
    where: { id: unidadId },
    select: {
      id: true,
      proyectoId: true,
      proyecto: { select: { companyId: true } },
    },
  });
  if (!unidad || unidad.proyectoId !== id) {
    throw new AuthzError(404, "Unidad no encontrada");
  }
  await requireWriter(unidad.proyecto.companyId, req);
  await requireModule(unidad.proyecto.companyId, "CONSTRUCCION");
  return unidad;
}

export const PUT = withAuthz(
  async (
    req: Request,
    ctx: { params: Promise<{ id: string; unidadId: string }> }
  ) => {
    const { id, unidadId } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      );
    }

    await loadAndGuard(id, unidadId, req);

    // Parent-cycle guard
    if (parsed.data.parentId) {
      if (parsed.data.parentId === unidadId) {
        return NextResponse.json(
          { error: "Una unidad no puede ser su propio padre" },
          { status: 400 }
        );
      }
      let cursor: string | null = parsed.data.parentId;
      while (cursor) {
        if (cursor === unidadId) {
          return NextResponse.json({ error: "Ciclo detectado" }, { status: 400 });
        }
        const anc: { parentId: string | null } | null =
          await prisma.unidadProyecto.findUnique({
            where: { id: cursor },
            select: { parentId: true },
          });
        cursor = anc?.parentId ?? null;
      }
    }

    const updated = await prisma.unidadProyecto.update({
      where: { id: unidadId },
      data: {
        ...(parsed.data.nombre !== undefined && { nombre: parsed.data.nombre }),
        ...(parsed.data.tipo !== undefined && { tipo: parsed.data.tipo }),
        ...(parsed.data.codigo !== undefined && { codigo: parsed.data.codigo }),
        ...(parsed.data.parentId !== undefined && { parentId: parsed.data.parentId }),
        ...(parsed.data.orden !== undefined && { orden: parsed.data.orden }),
        ...(parsed.data.metadata !== undefined && {
          metadata: parsed.data.metadata as never,
        }),
      },
    });

    return NextResponse.json(updated);
  }
);

export const DELETE = withAuthz(
  async (
    req: Request,
    ctx: { params: Promise<{ id: string; unidadId: string }> }
  ) => {
    const { id, unidadId } = await ctx.params;
    await loadAndGuard(id, unidadId, req);

    // Prisma will reject if descendants exist (no cascade on this FK).
    // Require the client to delete children first — safer than surprise cascade.
    const childCount = await prisma.unidadProyecto.count({
      where: { parentId: unidadId },
    });
    if (childCount > 0) {
      return NextResponse.json(
        {
          error: `Esta unidad tiene ${childCount} sub-unidades. Elimínalas primero.`,
        },
        { status: 422 }
      );
    }

    await prisma.unidadProyecto.delete({ where: { id: unidadId } });
    return NextResponse.json({ deleted: unidadId });
  }
);
