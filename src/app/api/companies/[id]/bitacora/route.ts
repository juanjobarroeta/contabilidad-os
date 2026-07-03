import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, withAuthz } from "@/lib/authz";

type Params = { params: Promise<{ id: string }> };

// GET /api/companies/[id]/bitacora — lectura de la bitácora de seguridad.
//
// Sólo OWNER/ADMIN de la empresa (ACCOUNTANT/VIEWER → 403): la bitácora expone
// quién hizo qué (correos, IPs, montos), así que es superficie de gobierno,
// no de operación diaria.
//
// Paginación por cursor: ?take=50 (máx 100) y ?cursor=<id de la última fila
// de la página anterior>. Orden: más recientes primero.
//
// La bitácora es append-only: este endpoint es de SOLO lectura y no existe
// ninguna superficie de edición/borrado de filas.
export const GET = withAuthz(async (req: Request, { params }: Params) => {
  const { id: companyId } = await params;
  await requireMembership(companyId, ["OWNER", "ADMIN"], req);

  const { searchParams } = new URL(req.url);
  const takeRaw = parseInt(searchParams.get("take") ?? "50", 10);
  const take = Math.min(Math.max(Number.isNaN(takeRaw) ? 50 : takeRaw, 1), 100);
  const cursor = searchParams.get("cursor");

  // take+1 para saber si hay página siguiente sin un count extra.
  const rows = await prisma.auditLog.findMany({
    where: { companyId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  const nextCursor = hasMore ? items[items.length - 1]?.id ?? null : null;

  return NextResponse.json({ items, nextCursor });
});
