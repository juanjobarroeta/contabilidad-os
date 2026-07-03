import { NextResponse } from "next/server";
import { getStripe } from "@/lib/billing/stripe";
import { applyStripeEvent, type StripeEventLike } from "@/lib/billing/stripe-events";
import { prismaBillingRepo } from "@/lib/billing/repo";

// POST /api/billing/webhook — receptor de eventos de Stripe.
//   - Verifica la firma sobre el cuerpo CRUDO (req.text() ANTES de parsear;
//     App Router no lo hace por nosotros). Firma inválida → 400.
//   - Falla cerrado: sin STRIPE_WEBHOOK_SECRET o sin llave, 503 y no procesa.
//   - La lógica vive en applyStripeEvent (pura, testeable); aquí sólo firma,
//     despacho y respuesta rápida. Cliente desconocido → log + 200 para no
//     ciclar los reintentos de Stripe.
// Eventos a suscribir en Stripe: checkout.session.completed,
// customer.subscription.updated, customer.subscription.deleted,
// invoice.payment_failed (ver .env.example).
export async function POST(req: Request) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret)
    return NextResponse.json(
      { error: "El webhook de Stripe no está configurado." },
      { status: 503 },
    );

  const signature = req.headers.get("stripe-signature");
  if (!signature)
    return NextResponse.json({ error: "Falta la firma de Stripe." }, { status: 400 });

  // Cuerpo crudo: imprescindible para verificar la firma.
  const rawBody = await req.text();

  let event: StripeEventLike;
  try {
    event = (await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      secret,
    )) as unknown as StripeEventLike;
  } catch {
    return NextResponse.json({ error: "Firma de Stripe inválida." }, { status: 400 });
  }

  try {
    const result = await applyStripeEvent(event, prismaBillingRepo());
    if (!result.handled) console.log(`[billing/webhook] ${result.detail}`);
    return NextResponse.json({ received: true });
  } catch (e) {
    // Error real (DB caída, etc.): 500 para que Stripe reintente.
    console.error(`[billing/webhook] error aplicando ${event.type}:`, e);
    return NextResponse.json({ error: "Error interno" }, { status: 500 });
  }
}
