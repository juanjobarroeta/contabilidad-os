/**
 * GET /api/automotriz/clientes/[id]/perfil
 *
 * Perfil 360° del cliente para el satélite: facturas emitidas con su estado de
 * cobro (conciliación) y de complementos (REPs emitidos vs cobros PPD),
 * saldo por cobrar y unidades que ha comprado. Solo lectura.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { perfilContacto } from "@/lib/automotriz/perfil-contacto";

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const contacto = await prisma.customer.findUnique({
      where: { id },
      select: { companyId: true },
    });
    if (!contacto) throw new AuthzError(404, "Cliente no encontrado");

    await requireMembership(contacto.companyId, undefined, req);
    await requireModule(contacto.companyId, "AUTOMOTRIZ", req);

    const perfil = await perfilContacto(prisma, contacto.companyId, id, "CLIENTE");
    if (!perfil) throw new AuthzError(404, "Cliente no encontrado");
    return NextResponse.json(perfil);
  }
);
