import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { autorizarJuridico, respuestaDeError } from "@/lib/juridico/api-guardia";
import { asegurarDespacho, listarMiembros, puede } from "@/lib/juridico/despacho";
import { appBaseUrl, getStripe, stripeConfigured } from "@/lib/billing/stripe";

// POST /api/juridico/suscripcion/checkout — la liga de pago del despacho.
// Se cobra por ASIENTO: la cantidad son los miembros que hay hoy (o la que
// mande el socio). Sólo el socio.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const d = await asegurarDespacho(userId);
  if (!puede(d.rol, "administrarDespacho")) return NextResponse.json({ error: "Sólo un socio contrata el plan del despacho." }, { status: 403 });

  const stripe = getStripe();
  const priceId = process.env.STRIPE_PRICE_JURIDICO_ASIENTO;
  if (!stripeConfigured() || !stripe || !priceId) {
    return NextResponse.json({ error: "El cobro todavía no está configurado en este entorno." }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as { asientos?: unknown; regresarA?: unknown };
  const miembros = await listarMiembros(d.despachoId);
  const asientos = Math.max(1, Math.min(50, Number(body.asientos) || miembros.length || 1));
  const base = appBaseUrl();
  const regresarA = typeof body.regresarA === "string" && /^https?:\/\//.test(body.regresarA) ? body.regresarA.replace(/\/$/, "") : base;

  try {
    const fila = await prisma.juridicoDespacho.findUnique({ where: { id: d.despachoId }, select: { stripeCustomerId: true } });
    const usuario = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
    const checkout = await stripe.checkout.sessions.create({
      mode: "subscription",
      ...(fila?.stripeCustomerId ? { customer: fila.stripeCustomerId } : { customer_email: usuario?.email ?? undefined }),
      line_items: [{ price: priceId, quantity: asientos }],
      client_reference_id: d.despachoId,
      // El webhook resuelve por aquí: es un despacho, no una empresa.
      metadata: { juridicoDespachoId: d.despachoId, userId, asientos: String(asientos) },
      subscription_data: { metadata: { juridicoDespachoId: d.despachoId, userId, asientos: String(asientos) } },
      allow_promotion_codes: true,
      locale: "es-419",
      success_url: `${regresarA}/?pago=exito`,
      cancel_url: `${regresarA}/?pago=cancelado`,
    });
    return NextResponse.json({ url: checkout.url, asientos });
  } catch (e) {
    return respuestaDeError(e);
  }
}
