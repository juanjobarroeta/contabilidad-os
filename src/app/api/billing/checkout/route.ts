import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { appBaseUrl, getStripe, resolveStripeCustomerId } from "@/lib/billing/stripe";
import { parsePlanFacturable, priceIdForPlan } from "@/lib/billing/planes-stripe";

// POST /api/billing/checkout — crea una sesión de Stripe Checkout (modo
// suscripción) para el plan solicitado y devuelve { url }. La moneda y el
// monto los define el objeto Price en Stripe (STRIPE_PRICE_*). Responde 503
// en español mientras Stripe no esté configurado.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    // body inválido → plan inválido abajo
  }
  const plan = parsePlanFacturable((body as { plan?: unknown } | null)?.plan);
  if (!plan)
    return NextResponse.json(
      { error: "Plan inválido. Opciones: BASICO, PROFESIONAL, DESPACHO." },
      { status: 400 },
    );

  const stripe = getStripe();
  const priceId = priceIdForPlan(plan);
  if (!stripe || !priceId)
    return NextResponse.json(
      { error: "Los pagos en línea aún no están habilitados. Intenta más tarde o contacta a soporte." },
      { status: 503 },
    );

  try {
    const customerId = await resolveStripeCustomerId(session.user.id);
    const base = appBaseUrl();

    const checkout = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // Redundancia deliberada: el webhook resuelve al usuario por
      // metadata.userId / client_reference_id y por stripeCustomerId.
      client_reference_id: session.user.id,
      metadata: { userId: session.user.id, plan },
      subscription_data: { metadata: { userId: session.user.id, plan } },
      allow_promotion_codes: true,
      locale: "es-419",
      success_url: `${base}/configuracion/facturacion?checkout=exito`,
      cancel_url: `${base}/configuracion/facturacion?checkout=cancelado`,
    });

    return NextResponse.json({ url: checkout.url });
  } catch (e) {
    console.error("[billing/checkout] error creando sesión de Stripe:", e);
    return NextResponse.json(
      { error: "No se pudo iniciar el pago. Intenta de nuevo más tarde." },
      { status: 500 },
    );
  }
}
