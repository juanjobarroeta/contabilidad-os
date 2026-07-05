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
  PRO: { dailyMsgsPerUser: 80, monthlyLlmUsd: 10 },
  DESPACHO: { dailyMsgsPerUser: 250, monthlyLlmUsd: 40 },
};

/** Topes de costo-seguridad del asistente de WhatsApp para un tier. */
export function whatsappLimites(plan: CompanyPlan): WhatsappLimites {
  return WHATSAPP_LIMITES[plan];
}

/**
 * Plan EFECTIVO para los topes de WhatsApp. Una empresa administrada por un
 * DESPACHO hereda los topes de DESPACHO: el despacho es el cliente que paga y
 * opera su cartera por WhatsApp, así que sus empresas deben ser consultables
 * aunque cada empresa individual esté en un tier sin WhatsApp (p.ej. ASISTENTE).
 * El presupuesto mensual por empresa sigue protegiendo el COGS empresa por
 * empresa. Una empresa INDEPENDIENTE (sin despacho) usa su propio tier.
 */
export function effectiveWhatsappPlan(company: {
  tier: CompanyPlan;
  despachoId: string | null;
}): CompanyPlan {
  return company.despachoId ? "DESPACHO" : company.tier;
}

// ── Tope de COSTO-SEGURIDAD del asistente DENTRO de la app ────────────────────
// El chat in-app está incluido en TODOS los tiers (la IA es parte del producto),
// pero igual lo metemos en presupuesto mensual de LLM por empresa para acotar el
// COGS ante un uso abusivo. Es un tope de COSTO, no de precio. Subtipo medido en
// CostEvent: "ai.chat".
const CHAT_LLM_USD_MENSUAL: Record<CompanyPlan, number> = {
  ASISTENTE: 8,
  AUTOMATIZADO: 15,
  PRO: 30,
  DESPACHO: 80,
};

/** Presupuesto mensual de LLM (USD) por empresa para el chat in-app, por tier. */
export function chatLlmUsdMensual(plan: CompanyPlan): number {
  return CHAT_LLM_USD_MENSUAL[plan];
}

// ── Tope diario de mensajes del chat in-app POR USUARIO ──────────────────────
// El presupuesto mensual de LLM protege el COGS a nivel EMPRESA, pero un solo
// usuario en una empresa con presupuesto amplio (p.ej. DESPACHO) puede vaciar
// ese presupuesto compartido y disparar el gasto sin backstop individual. Este
// tope diario por usuario cierra ese hueco: acota cuántos mensajes puede enviar
// una misma persona al día (zona horaria de México), igual que el
// `dailyMsgsPerUser` del asistente de WhatsApp. Es un tope de COSTO, no de
// precio; el chat sigue incluido en todos los tiers. Los números exactos son
// una decisión de producto: ajústalos a tu oferta.
const CHAT_MSGS_DIARIOS_POR_USUARIO: Record<CompanyPlan, number> = {
  ASISTENTE: 50,
  AUTOMATIZADO: 100,
  PRO: 200,
  DESPACHO: 400,
};

/** Tope diario de mensajes del chat in-app por usuario, por tier. */
export function dailyChatMsgsPerUser(plan: CompanyPlan): number {
  return CHAT_MSGS_DIARIOS_POR_USUARIO[plan];
}
