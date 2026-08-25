import { reportError } from "@/lib/observability";
import { NextResponse } from "next/server";
import { AuthzError, requireUser } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { appBaseUrl, getStripe } from "@/lib/billing/stripe";

// POST /api/billing/portal — crea una sesión del Billing Portal de Stripe para
// que el usuario administre su suscripción (método de pago, cancelación,
// facturas) y devuelve { url }. 503 en español si Stripe no está configurado.
// Bearer-aware: los satélites lo llaman con el token de /api/auth/token.
export async function POST(req: Request) {
  let session: { user: { id: string } };
  try {
    const user = await requireUser(req);
    session = { user: { id: user.id } };
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const stripe = getStripe();
  if (!stripe)
    return NextResponse.json(
      { error: "Los pagos en línea aún no están habilitados. Intenta más tarde o contacta a soporte." },
      { status: 503 },
    );

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { stripeCustomerId: true },
  });
  if (!user?.stripeCustomerId)
    return NextResponse.json(
      { error: "Aún no tienes una suscripción. Contrata un plan primero." },
      { status: 400 },
    );

  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${appBaseUrl()}/configuracion/facturacion`,
    });
    return NextResponse.json({ url: portal.url });
  } catch (e) {
    reportError(e, { ruta: "billing/portal", userId: session.user.id });
    return NextResponse.json(
      { error: "No se pudo abrir el portal de facturación. Intenta de nuevo más tarde." },
      { status: 500 },
    );
  }
}
