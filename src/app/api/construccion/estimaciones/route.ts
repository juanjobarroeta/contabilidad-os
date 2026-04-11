/**
 * GET /api/construccion/estimaciones?proyectoId=...
 *
 * List estimaciones for a proyecto.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const proyectoId = searchParams.get("proyectoId");
  if (!proyectoId) {
    return NextResponse.json({ error: "proyectoId requerido" }, { status: 400 });
  }

  const proyecto = await prisma.proyecto.findUnique({
    where: { id: proyectoId },
    select: { companyId: true },
  });
  if (!proyecto) {
    return NextResponse.json({ error: "Proyecto no encontrado" }, { status: 404 });
  }

  await requireMembership(proyecto.companyId, undefined, req);
  await requireModule(proyecto.companyId, "CONSTRUCCION");

  const estimaciones = await prisma.estimacion.findMany({
    where: { proyectoId },
    include: {
      partidas: {
        include: {
          presupuestoPartida: {
            include: {
              concepto: { select: { codigo: true, descripcion: true, unidad: true } },
            },
          },
        },
      },
    },
    orderBy: { numero: "asc" },
  });

  return NextResponse.json(estimaciones);
});
