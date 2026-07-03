import type { SubscriptionStatus } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Gating REAL de escrituras por suscripción. La decisión es PURA (testeable sin
// DB); la resolución por usuario vive en src/lib/subscription.ts. Mismo patrón
// que src/lib/billing/suspension.ts.
//
//   - Bandera SUBSCRIPTION_ENFORCEMENT_ENABLED (default OFF): apagada, TODAS
//     las escrituras pasan aunque la prueba haya vencido. Permite desplegar
//     antes de que el cobro en línea (Stripe) esté listo.
//   - Modelo de cobro: la suscripción vive en el User que ACTÚA (sesión o
//     Bearer token) — Company no tiene ownerId ni campo de billing. Es el mismo
//     modelo que usan TrialBanner y accesoSuspendido: cada usuario responde por
//     su propio subscriptionStatus/trialEndsAt.
//   - Sólo se bloquean ESCRITURAS. Las lecturas (GET) nunca se bloquean:
//     "modo solo lectura" real.
//
// Política por estado EFECTIVO (computeState ya convierte un TRIALING con
// trialEndsAt vencido en EXPIRED):
//   - ACTIVE / TRIALING vigente → escribe.
//   - PAST_DUE → periodo de GRACIA: escribe, con advertencia. No bloqueamos
//     mientras el cobro se reintenta; la advertencia se muestra globalmente vía
//     TrialBanner y /api/me (las rutas no la adjuntan por respuesta).
//   - EXPIRED / CANCELED → 402 con mensaje en español.
//   - El operador de plataforma NUNCA se bloquea (soporte/supervisión).
// ─────────────────────────────────────────────────────────────────────────────

export function enforcementHabilitado(): boolean {
  return process.env.SUBSCRIPTION_ENFORCEMENT_ENABLED === "true";
}

export type DecisionEscritura =
  | { permitido: true; advertencia: string | null }
  | { permitido: false; motivo: string };

const PERMITIDO: DecisionEscritura = { permitido: true, advertencia: null };

/** Decisión pura sobre (bandera, estado EFECTIVO, operador). */
export function decideEscritura(opts: {
  habilitado: boolean;
  esOperador: boolean;
  status: SubscriptionStatus;
}): DecisionEscritura {
  if (!opts.habilitado) return PERMITIDO;
  if (opts.esOperador) return PERMITIDO;
  switch (opts.status) {
    case "ACTIVE":
    case "TRIALING":
      return PERMITIDO;
    case "PAST_DUE":
      return {
        permitido: true,
        advertencia:
          "Tu último pago no se pudo procesar. Actualiza tu método de pago para evitar la suspensión del servicio.",
      };
    case "CANCELED":
      return {
        permitido: false,
        motivo: "Tu suscripción está cancelada. Reactívala para continuar.",
      };
    case "EXPIRED":
    default:
      return {
        permitido: false,
        motivo: "Tu prueba terminó. Activa tu suscripción para continuar.",
      };
  }
}
