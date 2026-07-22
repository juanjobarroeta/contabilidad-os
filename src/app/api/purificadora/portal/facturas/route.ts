import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withAuthz } from "@/lib/authz";
import { requirePortalAccount } from "@/lib/purificadora/portal";

// GET /api/purificadora/portal/facturas — los CFDIs emitidos a este cliente
// (sólo los suyos: el where lleva SIEMPRE el customerId del token).
export const GET = withAuthz(async (req: Request) => {
  const ctx = await requirePortalAccount(req);

  const facturas = await prisma.invoice.findMany({
    where: {
      companyId: ctx.companyId,
      customerId: ctx.customerId,
      tipo: "INGRESO",
      status: { in: ["STAMPED", "CANCELLED"] },
    },
    select: {
      id: true,
      uuid: true,
      serie: true,
      folio: true,
      fecha: true,
      subtotal: true,
      total: true,
      status: true,
      metodoPago: true,
    },
    orderBy: { fecha: "desc" },
    take: 200,
  });
  return NextResponse.json(facturas);
});
