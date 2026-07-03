/**
 * POST /api/construccion/adjudicaciones/[id]/enviar-tesoreria
 *
 * Admin manda una adjudicación POR_PAGAR a tesorería para pago: fija
 * enviadaTesoreriaAt. La tesorera trabaja del filtro "en tesorería" de cuentas
 * por pagar y registra el pago (pagar). Idempotente: reenviar refresca la fecha.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const adj = await prisma.solicitudAdjudicacion.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true },
    });
    if (!adj) throw new AuthzError(404, "Adjudicación no encontrada");
    await requireWriter(adj.companyId, req);
    await requireModule(adj.companyId, "CONSTRUCCION");

    if (adj.estado !== "POR_PAGAR") {
      return NextResponse.json(
        { error: "Esta adjudicación ya tiene el pago registrado" },
        { status: 409 }
      );
    }

    const updated = await prisma.solicitudAdjudicacion.update({
      where: { id },
      data: { enviadaTesoreriaAt: new Date() },
    });
    return NextResponse.json(updated);
  }
);
