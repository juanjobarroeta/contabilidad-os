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

  // Regreso al satélite que abrió el portal (PurificadoraOS administra su
  // suscripción sin salir de su app). Mismas defensas que el checkout: origen
  // de la lista blanca de CORS y ruta relativa simple, nunca un absoluto.
  const body = (await req.json().catch(() => null)) as {
    returnBase?: unknown;
    returnPath?: unknown;
  } | null;
  const allowedOrigins = (process.env.API_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const returnBase =
    typeof body?.returnBase === "string" && allowedOrigins.includes(body.returnBase)
      ? body.returnBase
      : null;
  const returnPath =
    typeof body?.returnPath === "string" && /^\/[A-Za-z0-9\-_/]*$/.test(body.returnPath)
      ? body.returnPath
      : null;
  const returnUrl = returnBase
    ? `${returnBase}${returnPath ?? "/"}`
    : `${appBaseUrl()}/configuracion/facturacion`;

  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: returnUrl,
    });
    return NextResponse.json({ url: portal.url });
  } catch (e) {
    reportError(e, { ruta: "billing/portal", userId: session.user.id });

    const err = e as { type?: string; code?: string; message?: string };

    // El id guardado es de otro modo/cuenta. NO se crea uno nuevo a propósito:
    // un cliente vacío ocultaría el problema y la desligaría de su suscripción
    // real. Mejor decirlo.
    if (err?.code === "resource_missing") {
      return NextResponse.json(
        {
          error:
            "Tu registro apunta a un cliente de Stripe que no existe para las llaves en uso. " +
            "Contacta a soporte para revincular la suscripción.",
        },
        { status: 500 },
      );
    }

    // Cualquier otro error de Stripe: se devuelve SU mensaje. Esta pantalla es
    // del dueño de la cuenta y el mensaje de Stripe suele traer la instrucción
    // exacta (p. ej. guardar la configuración del portal en el Dashboard);
    // esconderlo tras un genérico costó varias rondas de adivinanzas.
    if (err?.type?.startsWith("Stripe") && err?.message) {
      return NextResponse.json(
        { error: `Stripe: ${err.message}` },
        { status: 500 },
      );
    }

    return NextResponse.json(
      { error: "No se pudo abrir el portal de facturación. Intenta de nuevo más tarde." },
      { status: 500 },
    );
  }
}
