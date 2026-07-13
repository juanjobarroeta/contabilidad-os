/**
 * GET /api/restaurante/cocina?companyId=... [&estacion=COCINA|BARRA|POSTRES]
 *
 * The KDS (kitchen display) queue: every non-cancelled item of every OPEN
 * order that hasn't been delivered, oldest first. The satellite polls this
 * and drives estadoCocina via PATCH /ordenes/[id]/items/[itemId].
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "RESTAURANTE", req);

  const estacion = searchParams.get("estacion");

  const items = await prisma.restOrdenItem.findMany({
    where: {
      estadoCocina: { in: ["PENDIENTE", "EN_PREPARACION", "LISTO"] },
      ...(estacion ? { estacion: estacion as "COCINA" | "BARRA" | "POSTRES" } : {}),
      orden: { companyId, estado: "ABIERTA" },
    },
    include: {
      menuItem: { select: { id: true, nombre: true } },
      orden: {
        select: { id: true, folio: true, tipo: true, mesa: true, createdAt: true, notas: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(items);
});
