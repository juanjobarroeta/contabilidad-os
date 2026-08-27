// ─────────────────────────────────────────────────────────────────────────────
// RESICO — tracker de ingresos acumulados vs. límite anual del régimen (626).
// Exceder el límite anual (PF 3.5 MDP / PM 35 MDP, Art. 113-E LISR) es causal de
// EXPULSIÓN de RESICO: a partir del mes siguiente el contribuyente tributa en
// régimen general, con frecuencia sin opción de regresar. Por eso el aviso debe
// ser TEMPRANO (≥80% del límite), no en la declaración anual.
//
// Sólo aplica a RESICO (régimen 626); la variante PF/PM se determina con
// detectResicoKind (regimenFiscal + longitud de RFC) — no se reinventa aquí.
//
// NOTA (base "cobrado"): RESICO es base flujo (ingresos efectivamente cobrados).
// v1 aproxima con todos los INGRESO STAMPED del ejercicio (misma aproximación
// que documenta resico.ts); el contador puede ajustar manualmente.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { detectResicoKind } from "@/lib/resico";
import type { Hallazgo } from "./types";

// TODO(rules): el límite de ingresos de RESICO no existe aún en la capa `rules`
// (no hay getRule("isr.resico.limite_ingresos.*")). El contrato del repo pide que
// las constantes fiscales vivan en `rules` con vigencia + verificado; mientras
// tanto se hardcodean aquí. Ver propuesta §4.3.
/** Límite anual de ingresos RESICO PF (Art. 113-E LISR). */
export const LIMITE_RESICO_PF = 3_500_000;
/** Límite anual de ingresos RESICO PM (Art. 206/214 LISR). */
export const LIMITE_RESICO_PM = 35_000_000;

/** Datos que el check necesita para evaluar — desacoplado de Prisma para testear puro. */
export interface ResicoLimiteData {
  companyId: string;
  /** "pf" | "pm" | null — null = no es RESICO, no aplica. */
  kind: "pf" | "pm" | null;
  /** Ejercicio (año calendario) evaluado. */
  ejercicio: number;
  /** Ingresos acumulados (INGRESO STAMPED) del ejercicio en curso, MXN. */
  acumulado: number;
}

const fmt = (n: number) =>
  "$" + n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Carga los datos para el tracker de ingresos RESICO de una empresa al día `hoy`.
 * Si la empresa no es RESICO, `kind` será null y el check devolverá [].
 */
export async function cargarResicoLimite(
  companyId: string,
  hoy: Date,
): Promise<ResicoLimiteData> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { regimenFiscal: true, rfc: true },
  });

  const kind = company ? detectResicoKind(company.regimenFiscal, company.rfc) : null;
  const ejercicio = hoy.getUTCFullYear();

  if (!kind) {
    return { companyId, kind: null, ejercicio, acumulado: 0 };
  }

  // Ingresos cobrados acumulados del ejercicio en curso (aprox: stamped INGRESO).
  const from = new Date(Date.UTC(ejercicio, 0, 1));
  const to = new Date(Date.UTC(ejercicio + 1, 0, 1));
  const agg = await prisma.invoice.aggregate({
    where: {
      companyId,
      tipo: "INGRESO",
      status: "STAMPED",
      fecha: { gte: from, lt: to },
    },
    _sum: { total: true },
  });

  return { companyId, kind, ejercicio, acumulado: Number(agg._sum.total ?? 0) };
}

/**
 * Un hallazgo (a lo más) cuando los ingresos acumulados llegan al 80% del límite.
 * Severidad escala: ≥80% → warn, ≥90% → warn (mensaje más fuerte), ≥100% → error.
 * Empresas no-RESICO o por debajo del 80% → [].
 */
export function auditarResicoLimite(data: ResicoLimiteData): Hallazgo[] {
  if (!data.kind) return []; // no es RESICO → no aplica

  const limite = data.kind === "pf" ? LIMITE_RESICO_PF : LIMITE_RESICO_PM;
  if (limite <= 0) return [];

  const pct = data.acumulado / limite;
  if (pct < 0.8) return [];

  const pctTxt = (pct * 100).toFixed(0);
  const articulo = data.kind === "pf" ? "113-E" : "206";

  let severidad: Hallazgo["severidad"];
  let mensaje: string;
  let sugerencia: string;

  if (pct >= 1) {
    severidad = "error";
    mensaje =
      `Llevas ${fmt(data.acumulado)} de ingresos este año — ${pctTxt}% del límite RESICO de ${fmt(limite)}. ` +
      `Ya lo SUPERASTE: a partir del mes siguiente saldrías del régimen y deberás tributar en régimen general.`;
    sugerencia =
      "Avisa al SAT y prepara el cambio de régimen para el mes siguiente; revisa retenciones y CFDIs pendientes con tu contador.";
  } else if (pct >= 0.9) {
    severidad = "warn";
    mensaje =
      `Llevas ${fmt(data.acumulado)} de ingresos este año — ${pctTxt}% del límite RESICO de ${fmt(limite)}. ` +
      `Estás muy cerca del tope. Si lo superas, saldrías del régimen.`;
    sugerencia =
      "Estás a punto de rebasar el límite. Modera o difiere los ingresos restantes del ejercicio y prepara con tu contador un posible cambio de régimen.";
  } else {
    severidad = "warn";
    mensaje =
      `Llevas ${fmt(data.acumulado)} de ingresos este año — ${pctTxt}% del límite RESICO de ${fmt(limite)}. ` +
      `Si lo superas, saldrías del régimen.`;
    sugerencia =
      "Planea los ingresos restantes del ejercicio para no rebasar el límite; si prevés superarlo, anticipa el cambio de régimen con tu contador.";
  }

  return [
    {
      checkClave: "resico.ingresos_limite",
      severidad,
      mensaje,
      referencias: [data.companyId],
      fundamento: { ley: "LISR", articulo },
      sugerencia,
    },
  ];
}
