import { resolveRegimenTrack, type TipoPersonaFiscal } from "./regimen-capabilities";
import { summarizeRegimenDocumentBases, type RegimenDocumentInput, type RegimenInvoiceEvidence, type RegimenDocumentRow } from "./regimen-document-bases";

// A versioned review checklist, NOT an eligibility engine or deductible amount.
export const DEDUCTION_REVIEW_YEAR = 2026;
export const DEDUCTION_REVIEW_REASONS = {
  CLASSIFICATION_REVIEW: "Confirma la naturaleza del gasto; una clasificación automática no acredita deducibilidad.",
  PERSONAL_DEDUCTION_REVIEW: "El uso de deducción personal requiere revisión anual; no se suma a gastos de la actividad.",
  NO_FISCAL_EFFECTS_REVIEW: "El CFDI está clasificado sin efectos fiscales; revisa su tratamiento sin autorizar una deducción.",
  INVESTMENT_TREATMENT_REVIEW: "Revisa el activo, monto original, límites y depreciación; no se deduce la compra completa como gasto.",
  INVENTORY_TREATMENT_REVIEW: "Revisa el tratamiento de compras o costo de ventas según el régimen; no son intercambiables.",
  ACTIVITY_LINK_REVIEW: "Documenta la relación y necesidad del gasto para la actividad a la que se asignó.",
  DEDUCTION_REQUIREMENTS_REVIEW: "Revisa requisitos, límites, comprobantes y retenciones aplicables antes de autorizar una deducción.",
  PUE_PAYMENT_EVIDENCE_REQUIRED: "PUE no acredita por sí solo el pago efectivo ni su periodo.",
  PPD_PAYMENT_METHOD_UNAVAILABLE: "La forma de pago del REP no está conservada en esta relación; no se infiere del CFDI padre.",
  PAYMENT_METHOD_REVIEW: "La forma de pago declarada requiere evidencia y revisión de requisitos y excepciones.",
  RENTAL_ELECTION_REVIEW: "Confirma la opción de arrendamiento vigente y la relación con el inmueble; no se presume deducción ciega ni comprobada.",
  PLATFORM_ELECTION_REVIEW: "Confirma el tratamiento provisional o definitivo aplicable a plataformas y su periodo.",
  RESICO_PF_NO_ISR_DEDUCTION: "En RESICO PF la base mensual de ISR no se reduce con deducciones; esto no decide el acreditamiento de IVA.",
  RESICO_PM_TREATMENT_REVIEW: "RESICO PM tiene reglas propias de erogaciones y deducciones; no se aplica el tratamiento de RESICO PF.",
  REGIME_TREATMENT_REVIEW: "El tratamiento de deducciones de este régimen o tipo de contribuyente requiere revisión.",
  RULE_PERIOD_REVIEW: "El periodo está fuera de la versión 2026 de esta lista de revisión; no se extrapolan reglas fiscales.",
} as const;
export type DeductionReviewReason = keyof typeof DEDUCTION_REVIEW_REASONS;
export type DeductionTreatment = "GASTO_POR_REVISAR" | "INVERSION_POR_REVISAR" | "INVENTARIO_POR_REVISAR"
  | "PERSONAL_ANUAL_POR_REVISAR" | "SIN_EFECTOS_POR_REVISAR" | "CLASIFICACION_POR_REVISAR"
  | "REGIMEN_POR_REVISAR" | "RESICO_PF_SIN_DEDUCCION_ISR";

/** Neither a manual classification nor a reviewed allocation grants approval. */
function reviewAllocation(invoice: RegimenInvoiceEvidence, source: RegimenDocumentRow["source"], regimenCode: string,
  baseDocumentalCentavos: number, tipoPersona: TipoPersonaFiscal | null, period: string) {
  const metadata = invoice.expense;
  const usage = metadata?.usoCfdi?.trim().toUpperCase() ?? "";
  const nature = metadata?.naturaleza;
  const reasons = new Set<DeductionReviewReason>();
  let tratamiento: DeductionTreatment = "GASTO_POR_REVISAR";
  if (!metadata || !metadata.naturalezaManual || metadata.naturalezaRevision
    || !["GASTO", "INVERSION", "INVENTARIO", "SIN_EFECTOS"].includes(nature ?? "")) {
    reasons.add("CLASSIFICATION_REVIEW");
    tratamiento = "CLASIFICACION_POR_REVISAR";
  }
  // Recognize potentially special treatment without calling it legally eligible.
  if (/^D\d{2}$/.test(usage)) {
    tratamiento = "PERSONAL_ANUAL_POR_REVISAR"; reasons.add("PERSONAL_DEDUCTION_REVIEW");
  } else if (nature === "SIN_EFECTOS" || usage === "S01") {
    tratamiento = "SIN_EFECTOS_POR_REVISAR"; reasons.add("NO_FISCAL_EFFECTS_REVIEW");
  } else if (nature === "INVERSION" || /^I\d{2}$/.test(usage)) {
    tratamiento = "INVERSION_POR_REVISAR"; reasons.add("INVESTMENT_TREATMENT_REVIEW");
  } else if (nature === "INVENTARIO" || usage === "G01") {
    tratamiento = "INVENTARIO_POR_REVISAR"; reasons.add("INVENTORY_TREATMENT_REVIEW");
  }
  // Even an explicit classification override cannot erase conflicting source signals.
  if ((/^I\d{2}$/.test(usage) && nature !== "INVERSION") || (usage === "G01" && nature !== "INVENTARIO")
    || (usage === "S01" && nature !== "SIN_EFECTOS")) reasons.add("CLASSIFICATION_REVIEW");

  if (source === "PUE_DOCUMENTADO") reasons.add("PUE_PAYMENT_EVIDENCE_REQUIRED");
  else reasons.add("PPD_PAYMENT_METHOD_UNAVAILABLE");
  // A parent's formaPago (often 99 on PPD) is never substituted for FormaDePagoP.
  if (source === "PUE_DOCUMENTADO") reasons.add("PAYMENT_METHOD_REVIEW");

  const track = resolveRegimenTrack(regimenCode, tipoPersona);
  if (Number(period.slice(0, 4)) !== DEDUCTION_REVIEW_YEAR) {
    reasons.add("RULE_PERIOD_REVIEW"); tratamiento = "REGIMEN_POR_REVISAR";
  } else if (!track.ok) {
    reasons.add("REGIME_TREATMENT_REVIEW"); tratamiento = "REGIMEN_POR_REVISAR";
  } else if (regimenCode === "626" && tipoPersona === "PF") {
    reasons.add("RESICO_PF_NO_ISR_DEDUCTION"); tratamiento = "RESICO_PF_SIN_DEDUCCION_ISR";
  } else {
    reasons.add("ACTIVITY_LINK_REVIEW");
    reasons.add("DEDUCTION_REQUIREMENTS_REVIEW");
    if (regimenCode === "606") reasons.add("RENTAL_ELECTION_REVIEW");
    else if (regimenCode === "625") reasons.add("PLATFORM_ELECTION_REVIEW");
    else if (regimenCode === "626") reasons.add("RESICO_PM_TREATMENT_REVIEW");
    else if (regimenCode !== "601" && regimenCode !== "612") {
      reasons.add("REGIME_TREATMENT_REVIEW"); tratamiento = "REGIMEN_POR_REVISAR";
    }
  }
  return {
    regimenCode, baseDocumentalCentavos, tratamiento, estado: "PENDIENTE" as const,
    deduccionAutorizadaCentavos: null, motivos: [...reasons].sort(),
  };
}

/** Expense attribution plus an explicit, unapproved eligibility checklist. */
export function summarizeRegimenDeductions(input: RegimenDocumentInput, tipoPersona: TipoPersonaFiscal | null) {
  const projected = summarizeRegimenDocumentBases(input, "EGRESO");
  const invoices = new Map([...input.parents, ...input.issued].map((invoice) => [invoice.id, invoice]));
  const counts = new Map<DeductionReviewReason, number>();
  let assignments = 0;
  const rows = projected.renglones.map((row) => {
    const invoice = invoices.get(row.invoiceId)!;
    const elegibilidad = row.allocations.map((allocation) => {
      const review = reviewAllocation(invoice, row.source, allocation.regimenCode, allocation.amountCentavos, tipoPersona, input.period);
      assignments++;
      for (const reason of review.motivos) counts.set(reason, (counts.get(reason) ?? 0) + 1);
      return review;
    });
    return {
      ...row,
      clasificacion: {
        naturaleza: invoice.expense?.naturaleza ?? null,
        origen: !invoice.expense ? "DESCONOCIDA" : invoice.expense.naturalezaManual ? "MANUAL" : "AUTOMATICA",
        requiereRevision: elegibilidad.some((review) => review.motivos.includes("CLASSIFICATION_REVIEW")),
        usoCfdi: invoice.expense?.usoCfdi ?? null,
      },
      elegibilidad,
    };
  });
  return {
    version: 1 as const, periodo: input.period,
    estado: projected.estado === "SIN_EVIDENCIA" ? "SIN_EVIDENCIA" as const : "PENDIENTE" as const,
    usadaEnCalculoAutomatico: false as const, pueAcreditaPago: false as const,
    deduccionAutorizadaCentavos: null,
    documental: {
      estado: projected.estado, totales: projected.totales, porRegimen: projected.porRegimen,
      pendientes: projected.pendientes, duplicadosOmitidos: projected.duplicadosOmitidos,
    },
    renglones: rows,
    resumen: {
      renglones: rows.length, asignacionesPorRevisar: assignments, pendientesDocumentales: projected.pendientes.length,
      porMotivo: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count })),
    },
  };
}
