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
// Los tiers ASISTENTE y DESPACHO no se venden por Stripe.
//
// DESPACHO ya NO es un plan facturable: el modelo per-unit ($299 MXN por
// empresa, mínimo 10) se retiró por completo — los precios a despachos se
// negocian y se aplican con un código de descuento
// (src/lib/billing/codigos-descuento.ts) sobre Básico/Profesional. El TIER
// DESPACHO (CompanyPlan) sigue existiendo como nivel de capacidades y se
// asigna a mano por el operador, nunca por checkout. No quedaba ninguna
// suscripción activa con ese Price al retirarlo (0 empresas con tier
// DESPACHO en producción); si un webhook legado llegara con
// metadata.plan="DESPACHO", parsePlanFacturable devuelve null y el evento
// se ignora sin romper.
//
// Los MONTOS nunca se codifican aquí: viven en los objetos Price de Stripe
// (moneda incluida) referenciados por las variables de entorno STRIPE_PRICE_*.
// ─────────────────────────────────────────────────────────────────────────────

export const PLANES_FACTURABLES = ["BASICO", "PROFESIONAL"] as const;
export type PlanFacturable = (typeof PLANES_FACTURABLES)[number];

export function parsePlanFacturable(v: unknown): PlanFacturable | null {
  return typeof v === "string" && (PLANES_FACTURABLES as readonly string[]).includes(v)
    ? (v as PlanFacturable)
    : null;
}

export const PLAN_FACTURABLE_LABEL: Record<PlanFacturable, string> = {
  BASICO: "Básico",
  PROFESIONAL: "Profesional",
};

/** Plan comprado → tier de capacidades (lo que lee src/lib/planes.ts). */
export const PLAN_A_TIER: Record<PlanFacturable, CompanyPlan> = {
  BASICO: "AUTOMATIZADO",
  PROFESIONAL: "PRO",
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
  },
  anual: {
    BASICO: "STRIPE_PRICE_BASICO_ANUAL",
    PROFESIONAL: "STRIPE_PRICE_PRO_ANUAL",
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

// ─── Complementos (add-ons) ──────────────────────────────────────────────────
// Módulos a la medida que se cobran EN LA MISMA suscripción que el plan, como
// una segunda partida. El cliente pide el complemento por CLAVE, nunca por
// Price ID: el id sale del entorno, así que un satélite no puede inyectar un
// precio arbitrario en el checkout.
//
// El webhook no se entera: deriva el plan de metadata.plan, no de las
// partidas, así que agregar complementos no altera el tier aplicado.
export const COMPLEMENTOS = ["PURIFICADORA"] as const;
export type Complemento = (typeof COMPLEMENTOS)[number];

const COMPLEMENTO_ENV_VAR: Record<Complemento, string> = {
  PURIFICADORA: "STRIPE_PRICE_PURIFICADORA",
};

/** Parsea la lista de complementos del body; ignora claves desconocidas. */
export function parseComplementos(v: unknown): Complemento[] {
  if (!Array.isArray(v)) return [];
  return [
    ...new Set(
      v.filter((x): x is Complemento =>
        typeof x === "string" && (COMPLEMENTOS as readonly string[]).includes(x),
      ),
    ),
  ];
}

/** Price ID del complemento, o null si no está configurado en el entorno. */
export function priceIdForComplemento(
  complemento: Complemento,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const v = env[COMPLEMENTO_ENV_VAR[complemento]];
  return v && v.trim() !== "" ? v.trim() : null;
}

// ─── Uso extra de IA (pago único) ────────────────────────────────────────────
// Paquete que amplía el tope mensual de IA de UNA empresa para el mes en curso
// (ver IA_PAQUETE_EXTRA_USD en src/lib/planes.ts). Se cobra como pago único
// (Checkout mode=payment) con el Price de STRIPE_PRICE_IA_EXTRA; el webhook lo
// convierte en AiCreditGrant. Sin la variable, la compra responde 503.
export function priceIdIaExtra(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.STRIPE_PRICE_IA_EXTRA;
  return v && v.trim() !== "" ? v.trim() : null;
}
