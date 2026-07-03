import type { CompanyPlan, SubscriptionStatus } from "@prisma/client";
import { PLAN_A_TIER, parsePlanFacturable, type PlanFacturable } from "./planes-stripe";

// ─────────────────────────────────────────────────────────────────────────────
// Aplicación PURA de eventos de Stripe al estado de suscripción. La ruta del
// webhook sólo verifica la firma y delega aquí; esta capa recibe el evento ya
// parseado y un repositorio mínimo (BillingRepo), así que es testeable sin
// mockear el SDK ni prisma. Idempotente: re-aplicar el mismo evento escribe
// los mismos valores. Cliente/suscripción desconocidos NO son error (la ruta
// responde 200 para no ciclar los reintentos de Stripe): se reporta
// handled=false con el detalle para el log.
// ─────────────────────────────────────────────────────────────────────────────

/** Repositorio mínimo que necesita el webhook (implementación prisma en repo.ts). */
export interface BillingRepo {
  /** id del User con ese id, o null. */
  userIdById(id: string): Promise<string | null>;
  /** id del User con ese stripeCustomerId, o null. */
  userIdByStripeCustomer(customerId: string): Promise<string | null>;
  /** id del User con ese stripeSubscriptionId, o null. */
  userIdBySubscription(subscriptionId: string): Promise<string | null>;
  /** Actualiza campos de facturación del User. */
  updateUserBilling(
    userId: string,
    data: {
      subscriptionStatus?: SubscriptionStatus;
      stripeCustomerId?: string;
      stripeSubscriptionId?: string;
      currentPeriodEnd?: Date;
    },
  ): Promise<void>;
  /** Aplica el plan comprado a las empresas del usuario (ver planes-stripe.ts). */
  setPlanEmpresas(userId: string, plan: PlanFacturable, tier: CompanyPlan): Promise<void>;
}

/** Forma mínima de un evento de Stripe ya parseado/verificado. */
export type StripeEventLike = {
  type: string;
  data: { object: Record<string, unknown> };
};

export type ApplyResult = { handled: boolean; detail: string };

/**
 * Estado de suscripción de Stripe → enum interno.
 * Null = estado transitorio (incomplete, paused…) que no cambia nada.
 */
export function mapStripeStatus(status: string): SubscriptionStatus | null {
  switch (status) {
    case "active":
    case "trialing":
      return "ACTIVE";
    case "past_due":
      return "PAST_DUE";
    case "canceled":
    case "unpaid":
    case "incomplete_expired":
      return "CANCELED";
    default:
      return null;
  }
}

/**
 * Fin del periodo actual de una suscripción. Las versiones recientes del API
 * de Stripe movieron current_period_end del objeto Subscription a sus items;
 * se aceptan ambas formas.
 */
export function extractPeriodEnd(sub: Record<string, unknown>): Date | null {
  const direct = sub.current_period_end;
  if (typeof direct === "number") return new Date(direct * 1000);
  const items = (sub.items as { data?: unknown } | undefined)?.data;
  if (Array.isArray(items)) {
    const ends = items
      .map((i) => (i as { current_period_end?: unknown } | null)?.current_period_end)
      .filter((n): n is number => typeof n === "number");
    if (ends.length > 0) return new Date(Math.max(...ends) * 1000);
  }
  return null;
}

/** id de un campo expandible de Stripe: acepta "cus_…" o { id: "cus_…" }. */
function idOf(v: unknown): string | null {
  if (typeof v === "string" && v !== "") return v;
  if (v && typeof v === "object") {
    const id = (v as { id?: unknown }).id;
    if (typeof id === "string" && id !== "") return id;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Aplica un evento de Stripe (ya verificado) sobre el repositorio.
 * Eventos manejados:
 *   checkout.session.completed    → ACTIVE + stripeSubscriptionId + plan/tier
 *   customer.subscription.updated → mapStripeStatus + currentPeriodEnd
 *   customer.subscription.deleted → CANCELED
 *   invoice.payment_failed        → PAST_DUE
 */
export async function applyStripeEvent(
  event: StripeEventLike,
  repo: BillingRepo,
): Promise<ApplyResult> {
  const obj = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      // Sólo checkouts de suscripción (mode ausente en tests/fixtures = ok).
      if (str(obj.mode) && obj.mode !== "subscription")
        return { handled: false, detail: `checkout ignorado (mode=${obj.mode})` };

      const customerId = idOf(obj.customer);
      const subscriptionId = idOf(obj.subscription);
      const metadata = (obj.metadata ?? {}) as Record<string, unknown>;

      // Usuario: metadata.userId / client_reference_id (lo fija la ruta de
      // checkout), con fallback por stripeCustomerId.
      const refId = str(metadata.userId) ?? str(obj.client_reference_id);
      let userId = refId ? await repo.userIdById(refId) : null;
      if (!userId && customerId) userId = await repo.userIdByStripeCustomer(customerId);
      if (!userId)
        return { handled: false, detail: `checkout de usuario desconocido (customer=${customerId ?? "?"})` };

      await repo.updateUserBilling(userId, {
        subscriptionStatus: "ACTIVE",
        ...(customerId ? { stripeCustomerId: customerId } : {}),
        ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
      });

      const plan = parsePlanFacturable(metadata.plan);
      if (plan) await repo.setPlanEmpresas(userId, plan, PLAN_A_TIER[plan]);

      return {
        handled: true,
        detail: `checkout completado: user=${userId} plan=${plan ?? "sin plan en metadata"}`,
      };
    }

    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscriptionId = idOf(obj.id);
      const customerId = idOf(obj.customer);

      let userId = subscriptionId ? await repo.userIdBySubscription(subscriptionId) : null;
      if (!userId && customerId) userId = await repo.userIdByStripeCustomer(customerId);
      if (!userId)
        return {
          handled: false,
          detail: `suscripción desconocida (sub=${subscriptionId ?? "?"}, customer=${customerId ?? "?"})`,
        };

      const status =
        event.type === "customer.subscription.deleted"
          ? "CANCELED"
          : mapStripeStatus(str(obj.status) ?? "");
      const periodEnd = extractPeriodEnd(obj);

      await repo.updateUserBilling(userId, {
        ...(status ? { subscriptionStatus: status } : {}),
        ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
        ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
      });

      return {
        handled: true,
        detail: `${event.type}: user=${userId} status=${status ?? "sin cambio"}`,
      };
    }

    case "invoice.payment_failed": {
      const customerId = idOf(obj.customer);
      const userId = customerId ? await repo.userIdByStripeCustomer(customerId) : null;
      if (!userId)
        return { handled: false, detail: `pago fallido de cliente desconocido (customer=${customerId ?? "?"})` };

      await repo.updateUserBilling(userId, { subscriptionStatus: "PAST_DUE" });
      return { handled: true, detail: `pago fallido: user=${userId} → PAST_DUE` };
    }

    default:
      return { handled: false, detail: `evento no manejado: ${event.type}` };
  }
}
