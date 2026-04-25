/**
 * GET /api/construccion/solicitudes-compra/[id]
 *
 * Full requisición detail: header + partidas + all cotizaciones with
 * their per-line pricing. Drives the multi-vendor matrix UI in bartiz
 * (rows = partidas, cols = vendors).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireMembership,
  requireModule,
  withAuthz,
} from "@/lib/authz";

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const sol = await prisma.solicitudCompra.findUnique({
      where: { id },
      include: {
        proyecto: { select: { id: true, codigo: true, nombre: true } },
        supplier: { select: { id: true, razonSocial: true, rfc: true } },
        partidas: {
          include: {
            insumo: {
              select: { id: true, codigo: true, descripcion: true, unidad: true, costoActual: true },
            },
            presupuestoPartida: {
              select: { id: true, codigo: true },
            },
          },
        },
        cotizaciones: {
          include: {
            supplier: { select: { id: true, razonSocial: true, rfc: true } },
            partidas: true,
          },
          orderBy: { fechaCotizacion: "desc" },
        },
      },
    });
    if (!sol) throw new AuthzError(404, "Solicitud no encontrada");
    await requireMembership(sol.companyId, undefined, req);
    await requireModule(sol.companyId, "CONSTRUCCION");
    return NextResponse.json(sol);
  }
);
