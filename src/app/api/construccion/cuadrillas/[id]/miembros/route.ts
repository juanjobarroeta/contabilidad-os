/**
 * POST /api/construccion/cuadrillas/[id]/miembros   — add miembro
 * PUT  /api/construccion/cuadrillas/[id]/miembros   — bulk replace
 *
 * A miembro is either a free-text name (cash-only worker) or an
 * IMSS-registered Employee (employeeId FK).
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
  nombre: z.string().min(1).max(120),
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
  await requireModule(cuadrilla.companyId, "CONSTRUCCION_CUADRILLAS");
  return cuadrilla;
}

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    await loadAndGuard(id, req);
    const body = await req.json().catch(() => ({}));
    const parsed = miembroSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const created = await prisma.cuadrillaMiembro.create({
      data: {
        cuadrillaId: id,
        nombre: parsed.data.nombre,
        employeeId: parsed.data.employeeId,
        rolEnCuadrilla: parsed.data.rolEnCuadrilla,
      },
    });
    return NextResponse.json(created, { status: 201 });
  }
);
