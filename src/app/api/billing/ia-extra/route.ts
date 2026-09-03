import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { appBaseUrl, getStripe, resolveStripeCustomerId } from "@/lib/billing/stripe";
import { priceIdIaExtra } from "@/lib/billing/planes-stripe";
import { periodoActualMx } from "@/lib/ai/guardia";
import { IA_PAQUETE_EXTRA_USD } from "@/lib/planes";
import { reportError } from "@/lib/observability";

// POST /api/billing/ia-extra  { companyId }
//
// Compra de USO EXTRA de IA para una empresa en el mes en curso: crea una sesión
// de Stripe Checkout de pago ÚNICO (mode=payment) con el Price de
// STRIPE_PRICE_IA_EXTRA. El webhook (checkout.session.completed con
// metadata.tipo="ia_extra") suma el paquete (IA_PAQUETE_EXTRA_USD) como
// AiCreditGrant al tope de la empresa para ese periodo. Sólo OWNER/ADMIN de la
// empresa: es quien decide gastar dinero en ella.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const companyId = typeof body?.companyId === "string" ? body.companyId : "";
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || (member.role !== "OWNER" && member.role !== "ADMIN")) {
    return NextResponse.json({ error: "Sólo el propietario o un administrador de la empresa puede ampliar el límite." }, { status: 403 });
  }

  const stripe = getStripe();
  const priceId = priceIdIaExtra();
  if (!stripe || !priceId) {
    return NextResponse.json(
      { error: "La compra de uso extra aún no está habilitada. Escríbenos y lo ampliamos manualmente." },
      { status: 503 },
    );
  }

  const periodo = periodoActualMx();
  try {
    const customerId = await resolveStripeCustomerId(session.user.id);
    const base = appBaseUrl();
    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: session.user.id,
      metadata: {
        tipo: "ia_extra",
        userId: session.user.id,
        companyId,
        periodo,
        usd: String(IA_PAQUETE_EXTRA_USD),
      },
      locale: "es-419",
      success_url: `${base}/configuracion/facturacion?ia=exito`,
      cancel_url: `${base}/configuracion/facturacion?ia=cancelado`,
    });
    return NextResponse.json({ url: checkout.url });
  } catch (e) {
    reportError(e, { ruta: "billing/ia-extra", userId: session.user.id, companyId });
    return NextResponse.json({ error: "No se pudo iniciar el pago. Intenta de nuevo." }, { status: 502 });
  }
}
