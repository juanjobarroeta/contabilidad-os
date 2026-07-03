/**
 * POST /api/construccion/gastos/[id]/enviar-tesoreria
 *
 * Admin manda un gasto APROBADO a tesorería para pago: fija enviadaTesoreriaAt.
 * La tesorera trabaja del filtro "en tesorería" de cuentas por pagar y registra
 * el pago (aprobar-pagar). Idempotente: reenviar sólo refresca la fecha.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const gasto = await prisma.gasto.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true },
    });
    if (!gasto) throw new AuthzError(404, "Gasto no encontrado");
    await requireWriter(gasto.companyId, req);
    await requireModule(gasto.companyId, "CONSTRUCCION");

    if (gasto.estado !== "APROBADO") {
      return NextResponse.json(
        { error: `Solo se pueden enviar a tesorería gastos APROBADOS (actual: ${gasto.estado})` },
        { status: 422 }
      );
    }

    const updated = await prisma.gasto.update({
      where: { id },
      data: { enviadaTesoreriaAt: new Date() },
    });
    return NextResponse.json(updated);
  }
);
