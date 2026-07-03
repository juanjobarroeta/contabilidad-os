import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isOperador } from "@/lib/authz";
import { enforcementHabilitado, getUserSubscriptionState } from "@/lib/subscription";

// GET /api/me — datos ligeros del usuario para la UI (p.ej. mostrar herramientas
// internas sólo al operador de plataforma) + estado EFECTIVO de la suscripción
// (con TRIALING vencido ya convertido en EXPIRED) y si el gating de escrituras
// está encendido (SUBSCRIPTION_ENFORCEMENT_ENABLED), para que la UI reaccione
// de forma consistente con el backend.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [esOperador, subscription] = await Promise.all([
    isOperador(session.user.id),
    getUserSubscriptionState(session.user.id),
  ]);

  return NextResponse.json({
    esOperador,
    subscription: {
      status: subscription.status,
      trialEndsAt: subscription.trialEndsAt,
      daysLeft: subscription.daysLeft,
      isActive: subscription.isActive,
      isExpired: subscription.isExpired,
      enforcementEnabled: enforcementHabilitado(),
    },
  });
}
