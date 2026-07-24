/**
 * GET /api/automotriz/proveedores/[id]/perfil
 *
 * Perfil 360° del proveedor para el satélite: facturas recibidas con su estado
 * de pago (conciliación) y de complementos (REPs que NOS DEBE por pagos PPD —
 * riesgo de deducción, Art. 5-I LIVA), saldo por pagar y unidades que nos
 * suministró. El id es el Customer canónico de la contraparte (el import del
 * SAT registra al emisor de cada CFDI recibido como Customer por RFC).
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
    if (!contacto) throw new AuthzError(404, "Proveedor no encontrado");

    await requireMembership(contacto.companyId, undefined, req);
    await requireModule(contacto.companyId, "AUTOMOTRIZ", req);

    const perfil = await perfilContacto(prisma, contacto.companyId, id, "PROVEEDOR");
    if (!perfil) throw new AuthzError(404, "Proveedor no encontrado");
    return NextResponse.json(perfil);
  }
);
