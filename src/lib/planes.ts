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
