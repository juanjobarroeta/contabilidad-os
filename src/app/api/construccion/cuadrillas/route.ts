/**
 * GET  /api/construccion/cuadrillas?proyectoId=...
 * POST /api/construccion/cuadrillas
 *
 * Cuadrillas = per-especialidad trade teams scoped to a proyecto.
 * Module-flag gated on CONSTRUCCION_CUADRILLAS — Bartiz doesn't see
 * these endpoints (403 from requireModule).
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
  proyectoId: z.string().min(1),
  nombre: z.string().min(1).max(120),
  especialidad: z.string().min(1).max(40),
  jefeNombre: z.string().max(80).nullable().optional(),
  notas: z.string().max(500).nullable().optional(),
});

export const GET = withAuthz(async (req: Request) => {
  const url = new URL(req.url);
  const proyectoId = url.searchParams.get("proyectoId");
  if (!proyectoId) {
    return NextResponse.json({ error: "proyectoId requerido" }, { status: 400 });
  }
  const proyecto = await prisma.proyecto.findUnique({
    where: { id: proyectoId },
    select: { companyId: true },
  });
  if (!proyecto) throw new AuthzError(404, "Proyecto no encontrado");
  await requireMembership(proyecto.companyId, undefined, req);
  await requireModule(proyecto.companyId, "CONSTRUCCION_CUADRILLAS");

  const cuadrillas = await prisma.cuadrilla.findMany({
    where: { proyectoId, isActive: true },
    include: {
      miembros: {
        where: { isActive: true },
        orderBy: { createdAt: "asc" },
      },
      _count: { select: { rayas: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json(cuadrillas);
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const proyecto = await prisma.proyecto.findUnique({
    where: { id: parsed.data.proyectoId },
    select: { companyId: true },
  });
  if (!proyecto) throw new AuthzError(404, "Proyecto no encontrado");
  await requireWriter(proyecto.companyId, req);
  await requireModule(proyecto.companyId, "CONSTRUCCION_CUADRILLAS");

  try {
    const created = await prisma.cuadrilla.create({
      data: {
        companyId: proyecto.companyId,
        proyectoId: parsed.data.proyectoId,
        nombre: parsed.data.nombre,
        especialidad: parsed.data.especialidad,
        jefeNombre: parsed.data.jefeNombre,
        notas: parsed.data.notas,
      },
      include: { miembros: true, _count: { select: { rayas: true } } },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "P2002") {
      return NextResponse.json(
        { error: `Ya existe una cuadrilla con nombre "${parsed.data.nombre}" en este proyecto` },
        { status: 409 }
      );
    }
    throw e;
  }
});
