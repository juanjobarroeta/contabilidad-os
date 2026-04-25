/**
 * POST /api/construccion/solicitudes-compra/[id]/cotizaciones/[cotId]/seleccionar
 *
 * Marks one cotización as the winner. Atomic:
 *   1. Clears isSelected on every cotización of this solicitud
 *   2. Sets isSelected=true on the chosen one
 *   3. Pushes the cotización's prices into SolicitudPartida.precioUnitario
 *      so the SolicitudCompra.total reflects the winning bid.
 *   4. Sets SolicitudCompra.supplierId to the winner's supplier (when set).
 *
 * Body: {} — no params needed; cotización is identified by URL.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

const round2 = (n: number) => Math.round(n * 100) / 100;

export const POST = withAuthz(
  async (
    req: Request,
    ctx: { params: Promise<{ id: string; cotId: string }> }
  ) => {
    const { id, cotId } = await ctx.params;
    const cot = await prisma.solicitudCompraCotizacion.findUnique({
      where: { id: cotId },
      include: {
        partidas: true,
        solicitud: {
          select: {
            id: true,
            companyId: true,
            partidas: { select: { id: true, cantidad: true } },
          },
        },
      },
    });
    if (!cot || cot.solicitudId !== id) {
      throw new AuthzError(404, "Cotización no encontrada");
    }
    await requireWriter(cot.solicitud.companyId, req);
    await requireModule(cot.solicitud.companyId, "CONSTRUCCION");

    const result = await prisma.$transaction(async (tx) => {
      // Reset all sibling cotizaciones
      await tx.solicitudCompraCotizacion.updateMany({
        where: { solicitudId: id },
        data: { isSelected: false },
      });
      await tx.solicitudCompraCotizacion.update({
        where: { id: cotId },
        data: { isSelected: true },
      });

      // Push prices into SolicitudPartida
      for (const cotPart of cot.partidas) {
        const sp = cot.solicitud.partidas.find((p) => p.id === cotPart.solicitudPartidaId);
        if (!sp) continue;
        await tx.solicitudPartida.update({
          where: { id: cotPart.solicitudPartidaId },
          data: {
            precioUnitario: cotPart.precioUnitario,
            importe: round2(sp.cantidad * cotPart.precioUnitario),
          },
        });
      }

      // Recompute SolicitudCompra.total + bind supplierId if known
      const agg = await tx.solicitudPartida.aggregate({
        where: { solicitudId: id },
        _sum: { importe: true },
      });
      await tx.solicitudCompra.update({
        where: { id },
        data: {
          total: round2(agg._sum.importe ?? 0),
          ...(cot.supplierId && { supplierId: cot.supplierId }),
        },
      });

      return tx.solicitudCompra.findUnique({
        where: { id },
        include: {
          supplier: { select: { id: true, razonSocial: true } },
          partidas: true,
          cotizaciones: { include: { partidas: true } },
        },
      });
    });

    return NextResponse.json(result);
  }
);
