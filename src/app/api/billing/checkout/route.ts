import { NextResponse } from "next/server";
import { AuthzError, requireUser } from "@/lib/authz";
import { appBaseUrl, getStripe, resolveStripeCustomerId } from "@/lib/billing/stripe";
import {
  parseIntervaloFacturable,
  parsePlanFacturable,
  priceIdForPlan,
} from "@/lib/billing/planes-stripe";
import { cantidadDespacho } from "@/lib/billing/cantidad-despacho";
import { contarEmpresasFacturables } from "@/lib/billing/sync-cantidad-despacho";

// POST /api/billing/checkout — crea una sesión de Stripe Checkout (modo
// suscripción) para el plan e intervalo solicitados y devuelve { url }. La
// moneda y el monto los define el objeto Price en Stripe (STRIPE_PRICE_*;
// intervalo "anual" usa las variables *_ANUAL). Para DESPACHO (Price
// per-unit) la cantidad es max(10, empresas activas del comprador) — mismas
// empresas a las que el webhook aplica el tier. Responde 503 en español
// mientras Stripe (o el Price del intervalo pedido) no esté configurado.
export async function POST(req: Request) {
  // Bearer-aware: el wizard de onboarding de los satélites inicia el checkout
  // con el token de /api/auth/token; la web sigue entrando por cookie
  // (requireUser intenta ambos).
  let session: { user: { id: string } };
  try {
    const user = await requireUser(req);
    session = { user: { id: user.id } };
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

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
  const intervalo = parseIntervaloFacturable((body as { intervalo?: unknown } | null)?.intervalo);
  if (!intervalo)
    return NextResponse.json(
      { error: "Intervalo inválido. Opciones: mensual, anual." },
      { status: 400 },
    );

  const stripe = getStripe();
  const priceId = priceIdForPlan(plan, intervalo);
  if (!stripe || !priceId)
    return NextResponse.json(
      {
        // Distinguir "falta sólo el Price anual" ayuda al usuario a resolverlo
        // él mismo (cambiar a mensual) en vez de pensar que los pagos no sirven.
        error:
          stripe && intervalo === "anual"
            ? "El pago anual aún no está habilitado para este plan. Elige el intervalo mensual o contacta a soporte."
            : "Los pagos en línea aún no están habilitados. Intenta más tarde o contacta a soporte.",
      },
      { status: 503 },
    );

  // Un satélite puede pedir que Stripe regrese a SU origen (wizard de
  // onboarding). Sólo se acepta un origen de la misma lista blanca que usa el
  // CORS (API_ALLOWED_ORIGINS) — nunca una URL arbitraria (open redirect).
  const returnBaseRaw = (body as { returnBase?: unknown } | null)?.returnBase;
  const allowedOrigins = (process.env.API_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const returnBase =
    typeof returnBaseRaw === "string" && allowedOrigins.includes(returnBaseRaw)
      ? returnBaseRaw
      : null;

  try {
    const customerId = await resolveStripeCustomerId(session.user.id);
    const base = appBaseUrl();

    // DESPACHO es per-unit: cantidad = max(10, empresas activas del comprador).
    // El mismo conteo alimenta la sincronización en altas/bajas de empresas
    // (sync-cantidad-despacho.ts). Los demás planes cobran 1 unidad.
    const cantidad =
      plan === "DESPACHO"
        ? cantidadDespacho(await contarEmpresasFacturables(session.user.id))
        : 1;

    const checkout = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: cantidad }],
      // Redundancia deliberada: el webhook resuelve al usuario por
      // metadata.userId / client_reference_id y por stripeCustomerId.
      client_reference_id: session.user.id,
      metadata: { userId: session.user.id, plan, intervalo },
      subscription_data: { metadata: { userId: session.user.id, plan, intervalo } },
      allow_promotion_codes: true,
      locale: "es-419",
      success_url: returnBase
        ? `${returnBase}/onboarding?checkout=exito`
        : `${base}/configuracion/facturacion?checkout=exito`,
      cancel_url: returnBase
        ? `${returnBase}/onboarding?checkout=cancelado`
        : `${base}/configuracion/facturacion?checkout=cancelado`,
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
