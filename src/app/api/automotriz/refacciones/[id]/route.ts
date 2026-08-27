import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, withAuthz } from "@/lib/authz";

/**
 * GET /api/automotriz/refacciones/[id] — kardex de una parte: movimientos con
 * su CFDI de origen (entradas de compra, salidas de venta, ajustes).
 */
export const GET = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const refaccion = await prisma.refaccion.findUnique({
    where: { id },
    include: {
      movimientos: {
        orderBy: { fecha: "desc" },
        take: 200,
        include: {
          invoice: { select: { id: true, uuid: true, serie: true, folio: true, fecha: true } },
        },
      },
    },
  });
  if (!refaccion) throw new AuthzError(404, "Refacción no encontrada");
  await requireMembership(refaccion.companyId, undefined, req);
  await requireModule(refaccion.companyId, "AUTOMOTRIZ", req);

  const existencia = await prisma.refaccionMovimiento.aggregate({
    where: { refaccionId: id },
    _sum: { cantidad: true },
  });

  return NextResponse.json({
    ...refaccion,
    existencia: Math.round(Number(existencia._sum.cantidad ?? 0) * 100) / 100,
  });
});
