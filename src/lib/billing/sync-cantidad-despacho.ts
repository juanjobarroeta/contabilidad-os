import { prisma } from "@/lib/prisma";
import { registrarBitacora } from "@/lib/audit";
import { getStripe, stripeConfigured } from "./stripe";
import { despachoPriceIds } from "./planes-stripe";
import { cantidadDespacho } from "./cantidad-despacho";

// ─────────────────────────────────────────────────────────────────────────────
// Sincronización de la CANTIDAD del item de suscripción DESPACHO (per-unit por
// empresa, mínimo 10) con el número real de empresas activas del comprador.
// Se invoca fire-and-forget desde el alta (POST /api/companies) y la baja
// (DELETE /api/companies/[id]): un tropiezo de Stripe NUNCA debe bloquear
// crear o dar de baja una empresa — aquí todo error se loguea y se registra
// en bitácora (accion "billing.quantity-sync"), jamás se propaga.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Empresas activas facturables del usuario: mismas empresas a las que el
 * webhook aplica el tier comprado (repo.ts → setPlanEmpresas) — las que posee
 * con membresía OWNER y todas las del despacho al que pertenece — filtradas a
 * isActive (las dadas de baja no se cobran).
 */
export async function contarEmpresasFacturables(userId: string): Promise<number> {
  return prisma.company.count({
    where: {
      isActive: true,
      OR: [
        { members: { some: { userId, role: "OWNER" } } },
        { despacho: { members: { some: { userId } } } },
      ],
    },
  });
}

/**
 * Si el usuario tiene una suscripción ACTIVE cuyo item usa el Price DESPACHO
 * (mensual o anual), actualiza su quantity a max(10, empresas activas).
 *
 * PRORRATEO: proration_behavior "create_prorations" — al subir la cantidad se
 * genera un cargo prorrateado por el resto del periodo (el despacho paga la
 * empresa nueva desde el día del alta, no desde la próxima factura) y al bajar
 * se genera crédito prorrateado. Es el comportamiento estándar de asientos
 * (seats) en Stripe y evita tanto regalar el resto del periodo como cobrarlo
 * dos veces.
 *
 * No-op silencioso cuando: Stripe no está configurado, no hay Price DESPACHO
 * en el entorno, el usuario no tiene suscripción ACTIVE, la suscripción no
 * tiene item con el Price DESPACHO (plan ≠ DESPACHO) o la cantidad ya
 * coincide. Nunca lanza.
 */
export async function sincronizarCantidadDespacho(
  userId: string,
  motivo: "empresa.alta" | "empresa.baja",
): Promise<void> {
  if (!stripeConfigured()) return;
  const preciosDespacho = despachoPriceIds();
  if (preciosDespacho.length === 0) return;

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { stripeSubscriptionId: true, subscriptionStatus: true },
    });
    if (!user?.stripeSubscriptionId || user.subscriptionStatus !== "ACTIVE") return;

    const stripe = getStripe();
    if (!stripe) return;

    const sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
    const item = sub.items.data.find((i) => preciosDespacho.includes(i.price?.id ?? ""));
    if (!item) return; // la suscripción no es del plan DESPACHO

    const empresasActivas = await contarEmpresasFacturables(userId);
    const cantidad = cantidadDespacho(empresasActivas);
    if (item.quantity === cantidad) return; // ya está sincronizada

    await stripe.subscriptionItems.update(item.id, {
      quantity: cantidad,
      proration_behavior: "create_prorations",
    });

    registrarBitacora({
      userId,
      accion: "billing.quantity-sync",
      entidad: "StripeSubscription",
      entidadId: user.stripeSubscriptionId,
      detalle: {
        motivo,
        empresasActivas,
        cantidadAnterior: item.quantity ?? null,
        cantidadNueva: cantidad,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[billing/quantity-sync] fallo sincronizando cantidad DESPACHO (motivo=${motivo}, user=${userId}):`,
      msg,
    );
    registrarBitacora({
      userId,
      accion: "billing.quantity-sync",
      entidad: "StripeSubscription",
      detalle: { motivo, error: msg },
    });
  }
}
