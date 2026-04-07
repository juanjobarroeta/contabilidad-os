/**
 * GET /api/construccion/conceptos/[id]
 *
 * Returns a concepto with its current APU fully expanded: each APUInsumo
 * line joined to the underlying Insumo master record. This is what the
 * APU editor UI needs to render the breakdown.
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

    const concepto = await prisma.concepto.findUnique({
      where: { id },
      include: {
        apuActual: {
          include: {
            insumos: {
              include: {
                insumo: {
                  select: {
                    id: true,
                    codigo: true,
                    descripcion: true,
                    tipo: true,
                    unidad: true,
                    costoActual: true,
                  },
                },
              },
              orderBy: { orden: "asc" },
            },
          },
        },
      },
    });

    if (!concepto) {
      throw new AuthzError(404, "Concepto no encontrado");
    }

    await requireMembership(concepto.companyId, undefined, req);
    await requireModule(concepto.companyId, "CONSTRUCCION");

    return NextResponse.json(concepto);
  }
);
