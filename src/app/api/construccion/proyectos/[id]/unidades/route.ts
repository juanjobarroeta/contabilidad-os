/**
 * GET  /api/construccion/proyectos/[id]/unidades
 * POST /api/construccion/proyectos/[id]/unidades
 *
 * UnidadProyecto = Torre / Nivel / Depto style subdivision of a proyecto.
 * Hierarchical (self-FK via parentId). Used by Decolsa-style multi-tower
 * projects where the same template presupuesto is consumed per unidad.
 *
 * GET returns flat list; client assembles the tree.
 * POST creates a new unidad. Body:
 *   { nombre, tipo?, codigo?, parentId?, orden?, metadata? }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireMembership,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

const createSchema = z.object({
  nombre: z.string().min(1).max(120),
  tipo: z.string().max(40).optional(),
  codigo: z.string().max(40).optional(),
  parentId: z.string().min(1).nullable().optional(),
  orden: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const proyecto = await prisma.proyecto.findUnique({
      where: { id },
      select: { id: true, companyId: true },
    });
    if (!proyecto) throw new AuthzError(404, "Proyecto no encontrado");

    await requireMembership(proyecto.companyId, undefined, req);
    await requireModule(proyecto.companyId, "CONSTRUCCION");

    const unidades = await prisma.unidadProyecto.findMany({
      where: { proyectoId: id },
      orderBy: [{ parentId: "asc" }, { orden: "asc" }, { nombre: "asc" }],
    });

    return NextResponse.json(unidades);
  }
);

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const proyecto = await prisma.proyecto.findUnique({
      where: { id },
      select: { id: true, companyId: true },
    });
    if (!proyecto) throw new AuthzError(404, "Proyecto no encontrado");

    await requireWriter(proyecto.companyId, req);
    await requireModule(proyecto.companyId, "CONSTRUCCION");

    if (parsed.data.parentId) {
      const parent = await prisma.unidadProyecto.findUnique({
        where: { id: parsed.data.parentId },
        select: { proyectoId: true },
      });
      if (!parent || parent.proyectoId !== id) {
        return NextResponse.json(
          { error: "parentId inválido" },
          { status: 400 }
        );
      }
    }

    let orden = parsed.data.orden;
    if (orden === undefined) {
      const tail = await prisma.unidadProyecto.aggregate({
        where: { proyectoId: id, parentId: parsed.data.parentId ?? null },
        _max: { orden: true },
      });
      orden = (tail._max.orden ?? -1) + 1;
    }

    const created = await prisma.unidadProyecto.create({
      data: {
        proyectoId: id,
        nombre: parsed.data.nombre,
        tipo: parsed.data.tipo,
        codigo: parsed.data.codigo,
        parentId: parsed.data.parentId ?? null,
        orden,
        metadata: parsed.data.metadata as never,
      },
    });

    return NextResponse.json(created, { status: 201 });
  }
);
