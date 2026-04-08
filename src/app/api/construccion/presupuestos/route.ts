/**
 * Presupuestos list, scoped by either companyId or proyectoId.
 *
 * GET /api/construccion/presupuestos?proyectoId=...
 * GET /api/construccion/presupuestos?companyId=...
 *
 * Returns lightweight rows suitable for a list UI — no partida details.
 * Use GET /api/construccion/presupuestos/[id] to drill into partidas.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const proyectoId = searchParams.get("proyectoId");
  const companyId = searchParams.get("companyId");

  if (!proyectoId && !companyId) {
    return NextResponse.json(
      { error: "Se requiere proyectoId o companyId" },
      { status: 400 }
    );
  }

  // Resolve the companyId we'll guard against
  let guardCompanyId = companyId;
  if (proyectoId) {
    const p = await prisma.proyecto.findUnique({
      where: { id: proyectoId },
      select: { companyId: true },
    });
    if (!p) {
      return NextResponse.json({ error: "Proyecto no encontrado" }, { status: 404 });
    }
    guardCompanyId = p.companyId;
  }

  await requireMembership(guardCompanyId!, undefined, req);
  await requireModule(guardCompanyId!, "CONSTRUCCION");

  const presupuestos = await prisma.presupuesto.findMany({
    where: proyectoId ? { proyectoId } : { companyId: guardCompanyId! },
    include: {
      proyecto: { select: { id: true, codigo: true, nombre: true } },
      _count: { select: { partidas: true, estimaciones: true } },
    },
    orderBy: [{ proyectoId: "asc" }, { version: "asc" }],
  });

  return NextResponse.json(presupuestos);
});
