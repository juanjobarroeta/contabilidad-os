import type { CompanyPlan } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Capacidades por plan/tier. El gating de COGS se deriva de aquí: una empresa
// sólo incurre costo de Syntage / banco (Belvo) / WhatsApp (Twilio) si su plan
// lo incluye. Centralizado para que UI, crons e integraciones coincidan.
//   ASISTENTE     → CFDIs + IA (COGS ~0)
//   AUTOMATIZADO  → + Syntage (opinión/CSF/declaraciones)
//   PRO           → + banco (Belvo) + WhatsApp (Twilio)
//   DESPACHO      → + revisión humana / SLA
// ─────────────────────────────────────────────────────────────────────────────

export function planIncluyeSyntage(plan: CompanyPlan): boolean {
  return plan !== "ASISTENTE";
}

export function planIncluyeBanco(plan: CompanyPlan): boolean {
  return plan === "PRO" || plan === "DESPACHO";
}

export function planIncluyeWhatsapp(plan: CompanyPlan): boolean {
  return plan === "PRO" || plan === "DESPACHO";
}

export const PLAN_LABEL: Record<CompanyPlan, string> = {
  ASISTENTE: "Asistente",
  AUTOMATIZADO: "Automatizado",
  PRO: "Pro",
  DESPACHO: "Despacho",
};

// ── Timbres incluidos por tier + precio del excedente ────────────────────────
// Cuota mensual de timbres (facturas + nómina + REP) incluida en cada tier; lo
// que pase se cobra como excedente al cliente. Son perillas de PRECIO (no de
// costo): ajústalas a tu oferta. Costo real por timbre ≈ $0.60 (ver rates.ts).
export const TIMBRES_INCLUIDOS: Record<CompanyPlan, number> = {
  ASISTENTE: 50,
  AUTOMATIZADO: 200,
  PRO: 500,
  DESPACHO: 1000,
};

/** Precio AL CLIENTE por timbre excedente (MXN). Margen sobre el ~$0.60 de costo. */
export const TIMBRE_EXCEDENTE_MXN = 3;

/** Timbres por encima de la cuota del tier (0 si está dentro). */
export function timbresExcedente(plan: CompanyPlan, usados: number): number {
  return Math.max(0, usados - TIMBRES_INCLUIDOS[plan]);
}

// ── Topes de COSTO-SEGURIDAD del asistente de WhatsApp ───────────────────────
// Defensa de COSTO (no de precio) contra un usuario verificado abusivo o una
// cartera de despacho (p.ej. 60 clientes) que dispare el gasto en LLM sin tope.
// Dos perillas por tier, centralizadas aquí:
//   - dailyMsgsPerUser  → mensajes/consultas entrantes por número (link) y día
//                         (zona horaria de México).
//   - monthlyLlmUsd     → presupuesto de LLM en USD por empresa y mes natural
//                         (suma de CostEvent categoría LLM, subtipo
//                         "whatsapp.agent").
// Los números exactos son una decisión de producto: ajústalos a tu oferta.
// Sólo los tiers con WhatsApp (PRO, DESPACHO) tienen tope > 0; el resto es 0 y
// `planIncluyeWhatsapp` ya bloquea antes de llegar aquí.
export interface WhatsappLimites {
  /** Tope de mensajes entrantes por usuario (link) por día. 0 = sin WhatsApp. */
  dailyMsgsPerUser: number;
  /** Presupuesto mensual de LLM (USD) por empresa para el asistente. 0 = sin WhatsApp. */
  monthlyLlmUsd: number;
}

const WHATSAPP_LIMITES: Record<CompanyPlan, WhatsappLimites> = {
  ASISTENTE: { dailyMsgsPerUser: 0, monthlyLlmUsd: 0 },
  AUTOMATIZADO: { dailyMsgsPerUser: 0, monthlyLlmUsd: 0 },
  PRO: { dailyMsgsPerUser: 40, monthlyLlmUsd: 5 },
  DESPACHO: { dailyMsgsPerUser: 60, monthlyLlmUsd: 25 },
};

/** Topes de costo-seguridad del asistente de WhatsApp para un tier. */
export function whatsappLimites(plan: CompanyPlan): WhatsappLimites {
  return WHATSAPP_LIMITES[plan];
}
