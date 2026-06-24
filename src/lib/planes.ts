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
