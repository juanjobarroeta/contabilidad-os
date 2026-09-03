/**
 * GET /api/hospital/contactos/[id]/perfil?direccion=CLIENTE|PROVEEDOR
 *
 * Perfil 360° del contacto para el satélite Hospital: facturas con su
 * evidencia de cobro/pago (conciliación + REPs), saldo con antigüedad, el
 * convenio ligado a este RFC y los episodios/pacientes que le facturan. La
 * empresa es la del propio contacto (fail-closed: 404 si no existe). Sólo
 * lectura.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { perfilContactoHospital } from "@/lib/hospital/perfil-contacto";

export const GET = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { searchParams } = new URL(req.url);
  const direccion = searchParams.get("direccion") === "PROVEEDOR" ? "PROVEEDOR" : "CLIENTE";

  const contacto = await prisma.customer.findUnique({ where: { id }, select: { companyId: true } });
  if (!contacto) throw new AuthzError(404, "Contacto no encontrado");

  await requireMembership(contacto.companyId, undefined, req);
  await requireModule(contacto.companyId, "HOSPITAL", req);

  const perfil = await perfilContactoHospital(prisma, contacto.companyId, id, direccion);
  if (!perfil) throw new AuthzError(404, "Contacto no encontrado");
  return NextResponse.json(perfil);
});
