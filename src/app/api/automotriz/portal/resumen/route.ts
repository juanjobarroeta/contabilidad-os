/**
 * GET /api/automotriz/portal/resumen — lo que el cliente ve: su estado de
 * cuenta (facturas, pagos, saldo, estatus de complementos) y sus unidades.
 * Todo acotado al customerId del token del portal (nunca datos de terceros;
 * el perfil se sirve del mismo perfilContacto que usa la agencia).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withAuthz } from "@/lib/authz";
import { requireAutoPortalAccount } from "@/lib/automotriz/portal";
import { perfilContacto } from "@/lib/automotriz/perfil-contacto";

export const GET = withAuthz(async (req: Request) => {
  const ctx = await requireAutoPortalAccount(req);
  const perfil = await perfilContacto(prisma, ctx.companyId, ctx.customerId, "CLIENTE");
  if (!perfil) return NextResponse.json({ error: "Cuenta sin datos" }, { status: 404 });

  // Vista del cliente: sin montos internos de la agencia (costos, márgenes).
  return NextResponse.json({
    cliente: perfil.contacto,
    resumen: perfil.resumen,
    facturas: perfil.facturas,
    unidades: perfil.unidades.map(({ costoCompra: _c, ...u }) => u),
  });
});
