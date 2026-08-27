/**
 * POST /api/construccion/estimaciones/[id]/aprobar
 *
 * Cambia estado BORRADOR → APROBADA. Una vez aprobada, las viviendas y
 * los importes quedan congelados (snapshot). El siguiente paso es vincular
 * un CFDI (vincular-invoice) y el pago del cliente (vincular-bt).
 *
 * Transitions:
 *   BORRADOR  → APROBADA   (este endpoint)
 *   APROBADA  → TIMBRADA   (vincular-invoice)
 *   TIMBRADA  → PAGADA     (vincular-bt)
 *
 * No mutamos las viviendas ni los importes — solo el estado. Los cómputos
 * ya quedaron en sus campos cacheados en la última PATCH.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const estimacion = await prisma.estimacion.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true, total: true, partidas: { select: { id: true }, take: 1 } },
    });
    if (!estimacion) throw new AuthzError(404, "Estimación no encontrada");
    await requireWriter(estimacion.companyId, req);
    await requireModule(estimacion.companyId, "CONSTRUCCION");

    if (estimacion.estado !== "BORRADOR") {
      return NextResponse.json(
        { error: `No se puede aprobar (estado: ${estimacion.estado})` },
        { status: 422 }
      );
    }
    if (estimacion.partidas.length === 0) {
      return NextResponse.json(
        { error: "La estimación no tiene partidas." },
        { status: 422 }
      );
    }
    if (Number(estimacion.total) <= 0) {
      return NextResponse.json(
        { error: "La estimación tiene total $0. Captura avance antes de aprobar." },
        { status: 422 }
      );
    }

    const updated = await prisma.estimacion.update({
      where: { id },
      data: { estado: "APROBADA" },
    });
    return NextResponse.json(updated);
  }
);
