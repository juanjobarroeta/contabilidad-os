import Stripe from "stripe";
import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Cliente de Stripe (lazy). TODO el módulo degrada con gracia cuando Stripe no
// está configurado: getStripe() devuelve null y las rutas responden 503 con un
// mensaje en español, de modo que esto puede desplegarse ANTES de tener la
// cuenta de Stripe. Los precios/montos viven en Stripe (ver planes-stripe.ts).
// ─────────────────────────────────────────────────────────────────────────────

let client: Stripe | null = null;

/** ¿Hay llave secreta de Stripe en el entorno? */
export function stripeConfigured(): boolean {
  const key = process.env.STRIPE_SECRET_KEY;
  return typeof key === "string" && key.trim() !== "";
}

/** Cliente singleton de Stripe, o null si STRIPE_SECRET_KEY no está definida. */
export function getStripe(): Stripe | null {
  if (!stripeConfigured()) return null;
  if (!client) {
    // Sin apiVersion explícita: usa la versión anclada por el SDK instalado.
    client = new Stripe(process.env.STRIPE_SECRET_KEY!.trim());
  }
  return client;
}

/**
 * URL base absoluta de la app para success/cancel/return URLs.
 * Misma resolución que buildAcceptUrl (src/lib/invitations.ts):
 * NEXTAUTH_URL y, en su defecto, el dominio público de Railway.
 */
export function appBaseUrl(): string {
  const base =
    process.env.NEXTAUTH_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : "http://localhost:3000");
  return base.replace(/\/$/, "");
}

/**
 * Devuelve el stripeCustomerId del usuario, creando el Customer en Stripe (y
 * guardándolo en el User) la primera vez. Lanza si Stripe no está configurado
 * o el usuario no existe — las rutas deben validar antes con stripeConfigured().
 */
export async function resolveStripeCustomerId(userId: string): Promise<string> {
  const stripe = getStripe();
  if (!stripe) throw new Error("Stripe no está configurado");

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, stripeCustomerId: true },
  });
  if (!user) throw new Error("Usuario no encontrado");

  // El id guardado pertenece a UNA cuenta y UN modo de Stripe. Al pasar de
  // llaves de prueba a live (o al cambiar de cuenta) el id viejo deja de
  // existir, y usarlo revienta el checkout con "No such customer" — un cobro
  // que nunca ocurre. Se verifica y, si ya no existe, se crea uno nuevo en el
  // modo actual y se reemplaza; así la migración a live se cura sola.
  if (user.stripeCustomerId) {
    try {
      const existente = await stripe.customers.retrieve(user.stripeCustomerId);
      if (!existente.deleted) return user.stripeCustomerId;
    } catch (e) {
      if ((e as { code?: string })?.code !== "resource_missing") throw e;
    }
  }

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name ?? undefined,
    metadata: { userId: user.id },
  });

  // Carrera improbable (dos checkouts simultáneos del mismo usuario): el
  // unique de stripeCustomerId protege la DB; un Customer huérfano en Stripe
  // es inocuo.
  await prisma.user.update({
    where: { id: user.id },
    data: { stripeCustomerId: customer.id },
  });

  return customer.id;
}
