import type { CompanyPlan } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Planes FACTURABLES por Stripe y su mapeo a la persistencia interna.
//
// DECISIÓN DE MAPEO (dónde vive el "plan"):
//   - El ESTADO de cobro (subscriptionStatus, stripeCustomerId,
//     stripeSubscriptionId, currentPeriodEnd) vive en el User dueño de la
//     cuenta (billing-per-RFC, ver prisma/schema.prisma → User).
//   - Las CAPACIDADES se leen SIEMPRE de Company.tier (CompanyPlan) vía
//     src/lib/planes.ts (Syntage, banco, WhatsApp, timbres). El User NO tiene
//     campo de plan, así que al completarse un checkout el webhook aplica el
//     plan comprado a las empresas del comprador: las que tiene con membresía
//     OWNER y las del despacho al que pertenece.
//   - Company.plan (string "BASICO"|"PROFESIONAL"|"DESPACHO", elegido en el
//     onboarding sólo como UI) se actualiza junto con tier para que ambos
//     campos cuenten la misma historia.
//
// Mapeo plan comprado → CompanyPlan (tier de capacidades):
//   BASICO      → AUTOMATIZADO (sincronización SAT/Syntage; sin banco/WhatsApp)
//   PROFESIONAL → PRO          (+ conciliación bancaria + WhatsApp)
//   DESPACHO    → DESPACHO     (+ revisión humana / SLA, multiempresa)
// El tier ASISTENTE no se vende por Stripe (tier interno/degradado).
//
// Los MONTOS nunca se codifican aquí: viven en los objetos Price de Stripe
// (moneda incluida) referenciados por las variables de entorno STRIPE_PRICE_*.
// ─────────────────────────────────────────────────────────────────────────────

export const PLANES_FACTURABLES = ["BASICO", "PROFESIONAL", "DESPACHO"] as const;
export type PlanFacturable = (typeof PLANES_FACTURABLES)[number];

export function parsePlanFacturable(v: unknown): PlanFacturable | null {
  return typeof v === "string" && (PLANES_FACTURABLES as readonly string[]).includes(v)
    ? (v as PlanFacturable)
    : null;
}

export const PLAN_FACTURABLE_LABEL: Record<PlanFacturable, string> = {
  BASICO: "Básico",
  PROFESIONAL: "Profesional",
  DESPACHO: "Despacho",
};

/** Plan comprado → tier de capacidades (lo que lee src/lib/planes.ts). */
export const PLAN_A_TIER: Record<PlanFacturable, CompanyPlan> = {
  BASICO: "AUTOMATIZADO",
  PROFESIONAL: "PRO",
  DESPACHO: "DESPACHO",
};

// Intervalo de cobro. Cada intervalo tiene su propio objeto Price en Stripe:
// el anual se crea con monto = 10 meses del mensual («2 meses gratis»).
export const INTERVALOS_FACTURABLES = ["mensual", "anual"] as const;
export type IntervaloFacturable = (typeof INTERVALOS_FACTURABLES)[number];

/**
 * Parsea el intervalo del body del checkout. Ausente (undefined/null) →
 * "mensual" (default); cualquier otro valor no reconocido → null (400).
 */
export function parseIntervaloFacturable(v: unknown): IntervaloFacturable | null {
  if (v === undefined || v === null) return "mensual";
  return typeof v === "string" && (INTERVALOS_FACTURABLES as readonly string[]).includes(v)
    ? (v as IntervaloFacturable)
    : null;
}

// Variable de entorno con el Price ID de Stripe para cada plan × intervalo.
// PROFESIONAL usa STRIPE_PRICE_PRO (nombre corto en el entorno; "PROFESIONAL"
// en UI/onboarding). Los anuales llevan el sufijo _ANUAL (ver .env.example).
const PRICE_ENV_VAR: Record<IntervaloFacturable, Record<PlanFacturable, string>> = {
  mensual: {
    BASICO: "STRIPE_PRICE_BASICO",
    PROFESIONAL: "STRIPE_PRICE_PRO",
    DESPACHO: "STRIPE_PRICE_DESPACHO",
  },
  anual: {
    BASICO: "STRIPE_PRICE_BASICO_ANUAL",
    PROFESIONAL: "STRIPE_PRICE_PRO_ANUAL",
    DESPACHO: "STRIPE_PRICE_DESPACHO_ANUAL",
  },
};

/**
 * Resuelve el Price ID de Stripe para un plan e intervalo desde el entorno.
 * Null si la variable no está definida (Stripe sin configurar para esa
 * combinación — p. ej. anual aún no creado).
 */
export function priceIdForPlan(
  plan: PlanFacturable,
  intervalo: IntervaloFacturable = "mensual",
  env: Record<string, string | undefined> = process.env,
): string | null {
  const v = env[PRICE_ENV_VAR[intervalo][plan]];
  return v && v.trim() !== "" ? v.trim() : null;
}

/**
 * Price IDs configurados del plan DESPACHO (mensual y anual). Sirve para
 * reconocer el item per-unit dentro de una suscripción de Stripe al
 * sincronizar la cantidad (ver sync-cantidad-despacho.ts).
 */
export function despachoPriceIds(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return INTERVALOS_FACTURABLES.map((i) => priceIdForPlan("DESPACHO", i, env)).filter(
    (p): p is string => p !== null,
  );
}
