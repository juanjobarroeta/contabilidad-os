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

// Extractores permitidos durante un TRIAL (nadie paga aún). La probadita es la
// foto de cumplimiento (opinión + CSF) — barata y con efecto "wow"; el
// BACKFILL caro (5 ejercicios de anuales/mensuales + arranque de CE) queda
// para cuando alguien paga de verdad. Sin esto, un trial de una semana podía
// descargarse todo el historial con nuestro presupuesto de Syntage e irse.
export const EXTRACTORES_TRIAL: readonly ExtractorProvision[] = [
  "tax_compliance",
  "tax_status",
] as const;

/** Nivel de pago que gobierna la extracción (espejo de billing/pagadores.ts). */
export type NivelPagoExtraccion = "ACTIVO" | "TRIAL";

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

// Piso de reintento del arranque de Contabilidad Electrónica. El bootstrap de
// CE (`electronic_accounting`) está diseñado como disparo ÚNICO: el sync fija
// `ceBootstrapAt` al importar catálogo + balanza y no se vuelve a extraer.
// Pero si el SAT no devuelve CE (la mayoría de las PyMEs nunca la presentan),
// `ceBootstrapAt` se queda null para siempre y sin piso el provision lo
// re-disparaba CADA día (~30 extracciones/RFC/mes de puro reintento — con 10
// RFCs eso solo consumía ~300 de la cuota mensual). Con este piso, una empresa
// sin CE cuesta a lo más 1 extracción/mes.
export const CADENCIA_CE_REINTENTO_DIAS = 30;

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * ¿Toca disparar el arranque de Contabilidad Electrónica? Puro y testeable.
 * - Ya bootstrapeada (`ceBootstrapAt` fijado) → nunca (re-extraer la balanza
 *   del SAT sobre el libro vivo la re-importaría como apertura).
 * - Nivel TRIAL → nunca, NI con `force`: el arranque de CE es parte del
 *   backfill caro y `force` se dispara solo al subir la e.firma — justo la
 *   vía de abuso del trial. Se arranca solo cuando alguien paga (ACTIVO).
 * - Plan sin Syntage y sin `force` → no.
 * - Nunca intentada → sí.
 * - Intentada sin que aterrizara → sólo si el último intento tiene ≥ 30 días.
 * `force` (aprovisionamiento manual) brinca el piso, no el `ceBootstrapAt`.
 */
export function debeArrancarCE(opts: {
  plan: CompanyPlan;
  ceBootstrapAt: Date | null;
  /** Último disparo de `electronic_accounting` medido en CostEvent. */
  ultimoIntentoCE: Date | null;
  ahora: Date;
  force?: boolean;
  /** Ausente = ACTIVO (compatibilidad con llamadores previos). */
  nivelPago?: NivelPagoExtraccion;
}): boolean {
  if (opts.ceBootstrapAt != null) return false;
  if (opts.nivelPago === "TRIAL") return false;
  if (!planIncluyeSyntage(opts.plan) && !opts.force) return false;
  if (opts.force) return true;
  if (!opts.ultimoIntentoCE) return true;
  const dias = (opts.ahora.getTime() - opts.ultimoIntentoCE.getTime()) / DIA_MS;
  return dias >= CADENCIA_CE_REINTENTO_DIAS;
}

/**
 * Qué extractores disparar para una empresa. Puro y testeable.
 * - nivel TRIAL → sólo la probadita (EXTRACTORES_TRIAL), INCLUSO con `force`:
 *   el force se auto-dispara al subir la e.firma, que es exactamente cómo un
 *   trial de una semana se llevaba el backfill completo. El resto se extrae
 *   solo en cuanto alguien paga (la cadencia detecta lo que falta).
 * - `force` (onboarding / aprovisionamiento manual) → todos los permitidos.
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
  /** Ausente = ACTIVO (compatibilidad con llamadores previos). */
  nivelPago?: NivelPagoExtraccion;
}): ExtractorProvision[] {
  const permitidos =
    opts.nivelPago === "TRIAL" ? EXTRACTORES_TRIAL : EXTRACTORES_PROVISION;
  if (opts.force) return [...permitidos];
  if (!planIncluyeSyntage(opts.plan)) return [];
  return permitidos.filter((ex) => {
    const ultima = opts.ultimaPorExtractor[ex] ?? null;
    if (!ultima) return true; // nunca extraído
    const dias = (opts.ahora.getTime() - ultima.getTime()) / DIA_MS;
    // Falta el dato pese a haberse disparado antes → reintentar tras el piso.
    if (opts.datosPresentes?.[ex] === false) return dias >= CADENCIA_REINTENTO_DIAS;
    return dias >= CADENCIA_DIAS[ex];
  });
}
