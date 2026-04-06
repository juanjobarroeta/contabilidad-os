import type { SubscriptionStatus } from "@prisma/client";
import { prisma } from "./prisma";
import { AuthzError } from "./authz";

export type SubscriptionState = {
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  daysLeft: number | null; // null if not trialing
  isActive: boolean; // can write
  isTrialing: boolean;
  isExpired: boolean;
};

/**
 * Computes effective subscription state for a user.
 * If status is TRIALING but trialEndsAt has passed, treats as EXPIRED.
 */
export function computeState(input: {
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: Date | null;
}): SubscriptionState {
  const now = Date.now();
  let status = input.subscriptionStatus;
  let daysLeft: number | null = null;

  if (status === "TRIALING") {
    if (!input.trialEndsAt || input.trialEndsAt.getTime() <= now) {
      status = "EXPIRED";
    } else {
      daysLeft = Math.ceil((input.trialEndsAt.getTime() - now) / (24 * 60 * 60 * 1000));
    }
  }

  const isActive = status === "TRIALING" || status === "ACTIVE";

  return {
    status,
    trialEndsAt: input.trialEndsAt,
    daysLeft,
    isActive,
    isTrialing: status === "TRIALING",
    isExpired: status === "EXPIRED" || status === "CANCELED",
  };
}

export async function getUserSubscriptionState(userId: string): Promise<SubscriptionState> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { subscriptionStatus: true, trialEndsAt: true },
  });
  if (!user) throw new AuthzError(401, "Usuario no encontrado");
  return computeState(user);
}

/**
 * Throws AuthzError(402) if user cannot perform write operations.
 * Use in API routes that mutate data.
 */
export async function requireActiveSubscription(userId: string) {
  const state = await getUserSubscriptionState(userId);
  if (!state.isActive) {
    throw new AuthzError(402, "Tu prueba terminó. Activa tu suscripción para continuar.");
  }
  return state;
}
