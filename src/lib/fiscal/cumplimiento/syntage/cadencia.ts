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

// Piso de reintento cuando FALTA el dato (no sólo la cadencia). Un disparo
// previo medido en CostEvent no garantiza que el dato haya aterrizado (la
// extracción es async, pudo fallar, o el sync resolvió otra entidad). En ese
// caso re-disparamos aunque la cadencia diga "fresco" — pero respetando este
// piso para no martillar a Syntage cada corrida (ni encarecer entidades que
// genuinamente no tienen ese trámite, p.ej. un RFC nuevo sin anual cerrada).
export const CADENCIA_REINTENTO_DIAS = 3;

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Qué extractores disparar para una empresa. Puro y testeable.
 * - `force` (onboarding / aprovisionamiento manual) → los 4.
 * - plan sin Syntage (ASISTENTE) → ninguno.
 * - si el dato NO está presente (`datosPresentes[ex] === false`) → re-disparar
 *   aunque la cadencia diga "fresco", respetando el piso de reintento. Esto
 *   cura los huecos donde el CostEvent existe pero el dato nunca aterrizó.
 * - si no, sólo los que llevan ≥ su cadencia sin refrescarse (o nunca).
 */
export function extractoresADisparar(opts: {
  plan: CompanyPlan;
  ultimaPorExtractor: Partial<Record<ExtractorProvision, Date | null>>;
  ahora: Date;
  force?: boolean;
  /** Si el dato derivado de cada extractor ya existe en la BD. Ausente = no se evalúa. */
  datosPresentes?: Partial<Record<ExtractorProvision, boolean>>;
}): ExtractorProvision[] {
  if (opts.force) return [...EXTRACTORES_PROVISION];
  if (!planIncluyeSyntage(opts.plan)) return [];
  return EXTRACTORES_PROVISION.filter((ex) => {
    const ultima = opts.ultimaPorExtractor[ex] ?? null;
    if (!ultima) return true; // nunca extraído
    const dias = (opts.ahora.getTime() - ultima.getTime()) / DIA_MS;
    // Falta el dato pese a haberse disparado antes → reintentar tras el piso.
    if (opts.datosPresentes?.[ex] === false) return dias >= CADENCIA_REINTENTO_DIAS;
    return dias >= CADENCIA_DIAS[ex];
  });
}
