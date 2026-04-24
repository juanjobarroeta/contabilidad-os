/**
 * GET  /api/construccion/rayas?proyectoId=... [&estado=...]
 * POST /api/construccion/rayas
 *
 * A RayaSemanal is a per-cuadrilla, per-week cash-flow event. Creating
 * one sums the line-items (trabajos) and per-miembro detalles; the
 * server recomputes totalDestajo on every write. Marking PAGADA is a
 * separate endpoint that also creates the BankTransaction.
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

const trabajoSchema = z.object({
  presupuestoPartidaId: z.string().min(1).nullable().optional(),
  unidadProyectoId: z.string().min(1).nullable().optional(),
  descripcion: z.string().min(1).max(300),
  cantidad: z.number().nullable().optional(),
  unidad: z.string().max(20).nullable().optional(),
  importeDestajo: z.number().nonnegative(),
});

const detalleSchema = z.object({
  miembroId: z.string().min(1),
  diasTrabajados: z.number().min(0).max(7).default(6),
  importe: z.number().nonnegative(),
});

const createSchema = z.object({
  cuadrillaId: z.string().min(1),
  semanaInicio: z.string(), // ISO date; Monday 00:00 local expected
  semanaFin: z.string(),    // ISO date; Sunday 23:59 local expected
  notas: z.string().max(500).nullable().optional(),
  trabajos: z.array(trabajoSchema).default([]),
  detalles: z.array(detalleSchema).default([]),
});

const round2 = (n: number) => Math.round(n * 100) / 100;

export const GET = withAuthz(async (req: Request) => {
  const url = new URL(req.url);
  const proyectoId = url.searchParams.get("proyectoId");
  const estado = url.searchParams.get("estado");
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

  const rayas = await prisma.rayaSemanal.findMany({
    where: {
      proyectoId,
      ...(estado ? { estado: estado as "BORRADOR" | "APROBADA" | "PAGADA" } : {}),
    },
    include: {
      cuadrilla: { select: { id: true, nombre: true, especialidad: true } },
      _count: { select: { trabajos: true, detalles: true } },
    },
    orderBy: { semanaInicio: "desc" },
  });
  return NextResponse.json(rayas);
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const cuadrilla = await prisma.cuadrilla.findUnique({
    where: { id: parsed.data.cuadrillaId },
    select: { id: true, companyId: true, proyectoId: true },
  });
  if (!cuadrilla) throw new AuthzError(404, "Cuadrilla no encontrada");
  await requireWriter(cuadrilla.companyId, req);
  await requireModule(cuadrilla.companyId, "CONSTRUCCION_CUADRILLAS");

  const totalDestajo = round2(
    parsed.data.trabajos.reduce((a, t) => a + (t.importeDestajo || 0), 0)
  );

  try {
    const created = await prisma.$transaction(async (tx) => {
      const raya = await tx.rayaSemanal.create({
        data: {
          companyId: cuadrilla.companyId,
          proyectoId: cuadrilla.proyectoId,
          cuadrillaId: cuadrilla.id,
          semanaInicio: new Date(parsed.data.semanaInicio),
          semanaFin: new Date(parsed.data.semanaFin),
          notas: parsed.data.notas,
          totalDestajo,
          trabajos: {
            create: parsed.data.trabajos.map((t) => ({
              presupuestoPartidaId: t.presupuestoPartidaId,
              unidadProyectoId: t.unidadProyectoId,
              descripcion: t.descripcion,
              cantidad: t.cantidad,
              unidad: t.unidad,
              importeDestajo: t.importeDestajo,
            })),
          },
          detalles: {
            create: parsed.data.detalles.map((d) => ({
              miembroId: d.miembroId,
              diasTrabajados: d.diasTrabajados,
              importe: d.importe,
            })),
          },
        },
        include: {
          trabajos: true,
          detalles: { include: { miembro: true } },
          cuadrilla: { select: { id: true, nombre: true, especialidad: true } },
        },
      });
      return raya;
    });
    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "P2002") {
      return NextResponse.json(
        { error: "Ya existe una raya para esta cuadrilla en esa semana" },
        { status: 409 }
      );
    }
    throw e;
  }
});
