import { NextResponse } from "next/server";
import { AuthzError, requireUser } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { computeState } from "@/lib/subscription";
import { stripeConfigured } from "@/lib/billing/stripe";
import { PLAN_LABEL } from "@/lib/planes";

// GET /api/billing/suscripcion — estado de la suscripción del usuario, para
// que un satélite pueda mostrar (y contratar) su plan sin mandarlo a la web de
// contabilidad-os. Es el equivalente cross-origin de /api/me: aquél usa sólo
// cookie de sesión, éste acepta también el bearer de /api/auth/token.
//
// Sólo lee: contratar es POST /api/billing/checkout y administrar (tarjeta,
// facturas, cancelación) es POST /api/billing/portal — ambos ya con CORS.
export async function GET(req: Request) {
  let userId: string;
  try {
    const user = await requireUser(req);
    userId = user.id;
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      subscriptionStatus: true,
      trialEndsAt: true,
      currentPeriodEnd: true,
      stripeCustomerId: true,
    },
  });
  if (!user) throw new AuthzError(404, "Usuario no encontrado");

  const estado = computeState(user);

  // Plan mostrado: el tier de las empresas del usuario (OWNER o de su
  // despacho) — la misma fuente que la pantalla de facturación de la web.
  const empresas = await prisma.company.findMany({
    where: {
      OR: [
        { members: { some: { userId, role: "OWNER" } } },
        { despacho: { members: { some: { userId } } } },
      ],
    },
    select: { tier: true },
  });

  return NextResponse.json({
    status: estado.status,
    trialEndsAt: estado.trialEndsAt,
    daysLeft: estado.daysLeft,
    isActive: estado.isActive,
    isExpired: estado.isExpired,
    currentPeriodEnd: user.currentPeriodEnd,
    // Con cliente de Stripe ya se puede abrir el portal de administración.
    tieneSuscripcion: !!user.stripeCustomerId,
    planes: [...new Set(empresas.map((e) => PLAN_LABEL[e.tier]))],
    stripeConfigurado: stripeConfigured(),
  });
}
