import type { SubscriptionStatus } from "@prisma/client";
import { prisma } from "./prisma";
import { AuthzError, isOperador } from "./authz";
import { decideEscritura, enforcementHabilitado, type DecisionEscritura } from "./subscription-gate";

export { decideEscritura, enforcementHabilitado, type DecisionEscritura };

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
 * Versión INCONDICIONAL (ignora la bandera SUBSCRIPTION_ENFORCEMENT_ENABLED).
 * Throws AuthzError(402) if user cannot perform write operations.
 * Prefiere assertPuedeEscribir()/gateEscritura() para el gating detrás de
 * bandera; esta se conserva para usos que deban bloquear siempre.
 */
export async function requireActiveSubscription(userId: string) {
  const state = await getUserSubscriptionState(userId);
  // El operador de plataforma nunca se bloquea (soporte/supervisión).
  if (state.isActive || (await isOperador(userId))) return state;
  throw new AuthzError(402, "Tu prueba terminó. Activa tu suscripción para continuar.");
}

// ─── Gating real detrás de bandera (ver src/lib/subscription-gate.ts) ────────
// Sólo para ESCRITURAS; las lecturas nunca se bloquean. La política por estado
// (gracia en PAST_DUE, 402 en EXPIRED/CANCELED, operador exento) está
// documentada y testeada en subscription-gate.ts.

/** Resuelve la decisión de escritura para un usuario (bandera + estado + operador). */
export async function decideEscrituraUsuario(userId: string): Promise<DecisionEscritura> {
  if (!enforcementHabilitado()) return { permitido: true, advertencia: null };
  const [state, operador] = await Promise.all([
    getUserSubscriptionState(userId),
    isOperador(userId),
  ]);
  return decideEscritura({ habilitado: true, esOperador: operador, status: state.status });
}

/**
 * Lanza AuthzError(402) si el usuario no puede escribir (bandera encendida y
 * suscripción vencida/cancelada). Para rutas que ya atrapan AuthzError.
 * Devuelve la decisión, con `advertencia` cuando aplica (PAST_DUE en gracia).
 */
export async function assertPuedeEscribir(userId: string): Promise<DecisionEscritura> {
  const decision = await decideEscrituraUsuario(userId);
  if (!decision.permitido) throw new AuthzError(402, decision.motivo);
  return decision;
}

/**
 * Variante para rutas SIN try/catch de AuthzError: devuelve la respuesta 402
 * lista para retornar, o null si la escritura procede.
 *
 *   const gate = await gateEscritura(userId);
 *   if (gate) return gate;
 */
export async function gateEscritura(userId: string): Promise<Response | null> {
  const decision = await decideEscrituraUsuario(userId);
  if (!decision.permitido) {
    return Response.json({ error: decision.motivo }, { status: 402 });
  }
  return null;
}
