import type { CompanyPlan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BillingRepo } from "./stripe-events";
import type { PlanFacturable } from "./planes-stripe";

// Implementación prisma del BillingRepo que consume applyStripeEvent. Separada
// de stripe-events.ts para que la lógica pura sea testeable sin arrastrar
// prisma al grafo de imports (mismo criterio que billing/suspension.ts).

export function prismaBillingRepo(): BillingRepo {
  return {
    async userIdById(id) {
      const u = await prisma.user.findUnique({ where: { id }, select: { id: true } });
      return u?.id ?? null;
    },

    async userIdByStripeCustomer(customerId) {
      const u = await prisma.user.findUnique({
        where: { stripeCustomerId: customerId },
        select: { id: true },
      });
      return u?.id ?? null;
    },

    async userIdBySubscription(subscriptionId) {
      const u = await prisma.user.findUnique({
        where: { stripeSubscriptionId: subscriptionId },
        select: { id: true },
      });
      return u?.id ?? null;
    },

    async updateUserBilling(userId, data) {
      await prisma.user.update({ where: { id: userId }, data });
    },

    // Idempotente por stripeSessionId (@unique): un reintento del webhook no
    // duplica el crédito.
    async otorgarCreditoIA({ companyId, periodo, usd, stripeSessionId, userId }) {
      await prisma.aiCreditGrant.upsert({
        where: { stripeSessionId },
        create: { companyId, periodo, usd, motivo: "compra", stripeSessionId, otorgadoPorUserId: userId },
        update: {},
      });
    },

    // El plan comprado se aplica a las empresas del comprador: las que posee
    // con membresía OWNER y todas las del despacho al que pertenece (el
    // despacho es quien paga por su cartera). Ver mapeo en planes-stripe.ts.
    async setPlanEmpresas(userId: string, plan: PlanFacturable, tier: CompanyPlan) {
      await prisma.company.updateMany({
        where: {
          OR: [
            { members: { some: { userId, role: "OWNER" } } },
            { despacho: { members: { some: { userId } } } },
          ],
        },
        data: { plan, tier },
      });
    },
  };
}
