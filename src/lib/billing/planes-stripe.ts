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

// Variable de entorno con el Price ID de Stripe para cada plan. PROFESIONAL usa
// STRIPE_PRICE_PRO (nombre corto en el entorno; "PROFESIONAL" en UI/onboarding).
const PRICE_ENV_VAR: Record<PlanFacturable, string> = {
  BASICO: "STRIPE_PRICE_BASICO",
  PROFESIONAL: "STRIPE_PRICE_PRO",
  DESPACHO: "STRIPE_PRICE_DESPACHO",
};

/**
 * Resuelve el Price ID de Stripe para un plan desde el entorno.
 * Null si la variable no está definida (Stripe sin configurar para ese plan).
 */
export function priceIdForPlan(
  plan: PlanFacturable,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const v = env[PRICE_ENV_VAR[plan]];
  return v && v.trim() !== "" ? v.trim() : null;
}
