/**
 * POST /api/construccion/cuadrillas/[id]/miembros   — add miembro
 *
 * Un miembro es una persona en ESTA cuadrilla. Lo normal es ligarlo a su
 * Trabajador (registro único de la empresa, con su tarifa): así su
 * asistencia genera su jornal. Se acepta también sólo con nombre (como
 * antes), pero a ése no se le puede calcular jornal.
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

const miembroSchema = z.object({
  // Con trabajadorId, el nombre se toma del trabajador si no viene.
  nombre: z.string().min(1).max(120).optional(),
  trabajadorId: z.string().min(1).nullable().optional(),
  employeeId: z.string().min(1).nullable().optional(),
  rolEnCuadrilla: z.string().max(40).nullable().optional(),
});

async function loadAndGuard(id: string, req: Request) {
  const cuadrilla = await prisma.cuadrilla.findUnique({
    where: { id },
    select: { id: true, companyId: true },
  });
  if (!cuadrilla) throw new AuthzError(404, "Cuadrilla no encontrada");
  await requireWriter(cuadrilla.companyId, req);
  await requireModule(cuadrilla.companyId, "CONSTRUCCION");
  return cuadrilla;
}

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const cuadrilla = await loadAndGuard(id, req);
    const body = await req.json().catch(() => ({}));
    const parsed = miembroSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { trabajadorId, employeeId, rolEnCuadrilla } = parsed.data;

    // Las referencias deben ser de la MISMA empresa que la cuadrilla.
    let nombre = parsed.data.nombre;
    if (trabajadorId) {
      const t = await prisma.trabajador.findUnique({
        where: { id: trabajadorId },
        select: { companyId: true, nombre: true },
      });
      if (!t || t.companyId !== cuadrilla.companyId) {
        return NextResponse.json({ error: "Trabajador inválido" }, { status: 400 });
      }
      const ya = await prisma.cuadrillaMiembro.findFirst({
        where: { cuadrillaId: id, trabajadorId, isActive: true },
        select: { id: true },
      });
      if (ya) {
        return NextResponse.json({ error: "Ese trabajador ya está en la cuadrilla" }, { status: 409 });
      }
      nombre = nombre ?? t.nombre;
    }
    if (employeeId) {
      const e = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { companyId: true },
      });
      if (!e || e.companyId !== cuadrilla.companyId) {
        return NextResponse.json({ error: "Empleado inválido" }, { status: 400 });
      }
    }
    if (!nombre) {
      return NextResponse.json({ error: "nombre o trabajadorId requerido" }, { status: 400 });
    }

    const created = await prisma.cuadrillaMiembro.create({
      data: {
        cuadrillaId: id,
        nombre,
        trabajadorId: trabajadorId ?? null,
        employeeId: employeeId ?? null,
        rolEnCuadrilla: rolEnCuadrilla ?? null,
      },
      include: {
        trabajador: {
          select: { id: true, nombre: true, tipoPago: true, tarifa: true, horasJornada: true, especialidad: true },
        },
      },
    });
    return NextResponse.json(created, { status: 201 });
  }
);
