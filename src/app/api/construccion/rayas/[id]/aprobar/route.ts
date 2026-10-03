/**
 * POST /api/construccion/rayas/[id]/aprobar
 *
 * BORRADOR → APROBADA. Freezes the trabajos + detalles. Does NOT create
 * a BankTransaction yet; that happens on /pagar.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const raya = await prisma.rayaSemanal.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true, total: true },
    });
    if (!raya) throw new AuthzError(404, "Raya no encontrada");
    await requireWriter(raya.companyId, req);
    await requireModule(raya.companyId, "CONSTRUCCION");
    if (raya.estado !== "BORRADOR") {
      return NextResponse.json(
        { error: `Transición inválida: ${raya.estado} → APROBADA` },
        { status: 422 }
      );
    }
    // `total` = jornales + destajo: lo que se va a pagar.
    if (Number(raya.total) <= 0) {
      return NextResponse.json(
        { error: "La raya no tiene importe (ni jornales ni destajo)" },
        { status: 422 }
      );
    }
    const updated = await prisma.rayaSemanal.update({
      where: { id },
      data: { estado: "APROBADA" },
    });
    return NextResponse.json(updated);
  }
);
