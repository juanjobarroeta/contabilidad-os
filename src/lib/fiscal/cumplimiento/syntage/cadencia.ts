import type { CompanyPlan } from "@prisma/client";
import { planIncluyeSyntage } from "@/lib/planes";

// ─────────────────────────────────────────────────────────────────────────────
// Cadencia de extracciones Syntage. Cada extracción cuesta (Syntage cobra por
// pull), así que NO re-extraemos todo a diario: cada fuente se refresca según su
// ritmo real de cambio. Antes el provision disparaba las 4 cada día (~120/RFC/
// mes); con esto baja a ~10/RFC/mes. Además, las empresas sin Syntage en su plan
// (ASISTENTE) no extraen nada.
// ─────────────────────────────────────────────────────────────────────────────

// Sólo estas 4 se aprovisionan vía Syntage (los CFDIs vienen de Descarga Masiva
// propia, gratis; `invoice`/`tax_retention` no se disparan aquí).
export const EXTRACTORES_PROVISION = [
  "tax_compliance", // opinión de cumplimiento 32-D
  "tax_status", // CSF / constancia
  "annual_tax_return", // declaración anual
  "monthly_tax_return", // declaración mensual
] as const;
export type ExtractorProvision = (typeof EXTRACTORES_PROVISION)[number];

/** Días mínimos entre refrescos de cada fuente (su ritmo real de cambio). */
export const CADENCIA_DIAS: Record<ExtractorProvision, number> = {
  tax_compliance: 7, // opinión — semanal (cambia al pagar/declarar)
  tax_status: 30, // CSF — mensual (cambia rara vez)
  monthly_tax_return: 30, // mensual
  annual_tax_return: 90, // trimestral (capta la anual dentro del trimestre)
};

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Qué extractores disparar para una empresa. Puro y testeable.
 * - `force` (onboarding / aprovisionamiento manual) → los 4.
 * - plan sin Syntage (ASISTENTE) → ninguno.
 * - si no, sólo los que llevan ≥ su cadencia sin refrescarse (o nunca).
 */
export function extractoresADisparar(opts: {
  plan: CompanyPlan;
  ultimaPorExtractor: Partial<Record<ExtractorProvision, Date | null>>;
  ahora: Date;
  force?: boolean;
}): ExtractorProvision[] {
  if (opts.force) return [...EXTRACTORES_PROVISION];
  if (!planIncluyeSyntage(opts.plan)) return [];
  return EXTRACTORES_PROVISION.filter((ex) => {
    const ultima = opts.ultimaPorExtractor[ex] ?? null;
    if (!ultima) return true; // nunca extraído
    const dias = (opts.ahora.getTime() - ultima.getTime()) / DIA_MS;
    return dias >= CADENCIA_DIAS[ex];
  });
}
