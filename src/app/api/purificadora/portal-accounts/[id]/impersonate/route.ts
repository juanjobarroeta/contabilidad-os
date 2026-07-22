import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { signPurifPortalToken } from "@/lib/api-token";
import { registrarBitacora } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

// POST /api/purificadora/portal-accounts/[id]/impersonate
//
// «Ver como cliente»: al staff (writer del módulo) se le firma un token de
// portal de VIGENCIA CORTA (1 hora) para la cuenta del cliente, así ve
// exactamente lo mismo que él — mismas rutas, mismos datos, mismas guardias.
// Queda en bitácora quién entró como quién.
export const POST = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;

  const cuenta = await prisma.purifPortalAccount.findUnique({
    where: { id },
    include: {
      customer: { select: { razonSocial: true, rfc: true } },
      company: {
        select: { razonSocial: true, purifConfig: { select: { nombreComercial: true } } },
      },
    },
  });
  if (!cuenta) throw new AuthzError(404, "Cuenta no encontrada");

  const { user: actor } = await requireWriter(cuenta.companyId, req);
  await requireModule(cuenta.companyId, "PURIFICADORA", req);

  if (!cuenta.activo) {
    return NextResponse.json(
      { error: "La cuenta está suspendida — reactívala para previsualizar el portal" },
      { status: 422 }
    );
  }

  const token = await signPurifPortalToken(
    {
      sub: cuenta.id,
      companyId: cuenta.companyId,
      customerId: cuenta.customerId,
      email: cuenta.email,
    },
    { expiry: "1h" }
  );

  registrarBitacora({
    companyId: cuenta.companyId,
    userId: actor.id,
    actorEmail: actor.email,
    accion: "portal.impersonar",
    entidad: "PurifPortalAccount",
    entidadId: cuenta.id,
    detalle: { cliente: cuenta.customer.razonSocial, email: cuenta.email },
  });

  return NextResponse.json({
    token,
    expiresIn: 3600,
    cliente: { razonSocial: cuenta.customer.razonSocial, rfc: cuenta.customer.rfc },
    negocio: cuenta.company.purifConfig?.nombreComercial ?? cuenta.company.razonSocial,
  });
});
