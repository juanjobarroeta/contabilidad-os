import type { TipoPersonaFiscal } from "@/lib/fiscal/regimen-capabilities";
import type { RegimenDocumentInput, RegimenDocumentSummary, RegimenInvoiceEvidence } from "@/lib/fiscal/regimen-document-bases";
import type { DeductionReviewReason, DeductionTreatment } from "@/lib/fiscal/regimen-deduction-summary";
import { incomeEvidence } from "./income-v1";

export const deductionFixtureVersion = "2026-09-30.1";
export const deductionProfessionalReview = "PENDING";

/** Reuse synthetic documentary facts, not expected production output. */
export function deductionEvidence(): RegimenDocumentInput {
  const input = incomeEvidence();
  for (const invoice of [...input.issued, ...input.parents]) {
    invoice.tipo = "EGRESO";
    invoice.expense = { naturaleza: "GASTO", naturalezaManual: true, naturalezaRevision: false, usoCfdi: "G03", formaPago: "03" };
  }
  return input;
}
function changed(edit: (input: RegimenDocumentInput) => void) {
  const input = deductionEvidence(); edit(input); return input;
}
function metadata(input: RegimenDocumentInput, patch: Partial<NonNullable<RegimenInvoiceEvidence["expense"]>>) {
  for (const invoice of [...input.issued, ...input.parents]) Object.assign(invoice.expense!, patch);
}
function singleRegime(input: RegimenDocumentInput, code: string) {
  input.regimenCodes = [code];
  for (const invoice of [...input.issued, ...input.parents]) { invoice.regimenCodes = [code]; invoice.assignment = null; }
}
const normal = { estado: "PROYECTABLE" as const, totales: { pueDocumentadoCentavos: 9000, ppdRepCentavos: 45000 } };
const pending = (issue: string) => ({ estado: "PENDIENTE" as const, totales: null, issue });
interface DeductionCase {
  id: string;
  description: string;
  input: RegimenDocumentInput;
  tipoPersona: TipoPersonaFiscal | null;
  expected: {
    estado: RegimenDocumentSummary["estado"];
    totales: RegimenDocumentSummary["totales"];
    issue?: string;
    reason?: DeductionReviewReason;
    treatment?: DeductionTreatment;
  };
}
export const deductionCases: readonly DeductionCase[] = [
  { id: "DED-001", description: "Reviewed shares allocate discounted expense evidence, not deductions", input: deductionEvidence(), tipoPersona: "PF", expected: normal },
  { id: "DED-002", description: "Manual GASTO still needs activity and deduction requirements review", input: deductionEvidence(), tipoPersona: "PF", expected: { ...normal, reason: "ACTIVITY_LINK_REVIEW" } },
  { id: "DED-003", description: "Automatic classification is not accountant acceptance", input: changed((i) => metadata(i, { naturalezaManual: false })), tipoPersona: "PF", expected: { ...normal, reason: "CLASSIFICATION_REVIEW" } },
  { id: "DED-004", description: "An explicit unresolved classification flag survives manual attribution", input: changed((i) => metadata(i, { naturalezaRevision: true })), tipoPersona: "PF", expected: { ...normal, reason: "CLASSIFICATION_REVIEW" } },
  { id: "DED-005", description: "Missing nature is not silently converted to GASTO", input: changed((i) => metadata(i, { naturaleza: null })), tipoPersona: "PF", expected: { ...normal, treatment: "CLASIFICACION_POR_REVISAR" } },
  { id: "DED-006", description: "Investment purchases require asset and depreciation treatment", input: changed((i) => metadata(i, { naturaleza: "INVERSION", usoCfdi: "I04" })), tipoPersona: "PF", expected: { ...normal, treatment: "INVERSION_POR_REVISAR", reason: "INVESTMENT_TREATMENT_REVIEW" } },
  { id: "DED-007", description: "Inventory cannot be treated as an ordinary current expense", input: changed((i) => metadata(i, { naturaleza: "INVENTARIO", usoCfdi: "G01" })), tipoPersona: "PF", expected: { ...normal, treatment: "INVENTARIO_POR_REVISAR" } },
  { id: "DED-008", description: "S01 remains a no-fiscal-effects review, not an approved deduction", input: changed((i) => metadata(i, { naturaleza: "SIN_EFECTOS", usoCfdi: "S01" })), tipoPersona: "PF", expected: { ...normal, treatment: "SIN_EFECTOS_POR_REVISAR" } },
  { id: "DED-009", description: "Personal deduction use does not enter monthly business deductions", input: changed((i) => metadata(i, { usoCfdi: "D01" })), tipoPersona: "PF", expected: { ...normal, treatment: "PERSONAL_ANUAL_POR_REVISAR" } },
  { id: "DED-010", description: "A manual GASTO override cannot erase an investment-use conflict", input: changed((i) => metadata(i, { usoCfdi: "I04" })), tipoPersona: "PF", expected: { ...normal, reason: "CLASSIFICATION_REVIEW", treatment: "INVERSION_POR_REVISAR" } },
  { id: "DED-011", description: "A G01 source conflicts with a manual current-expense classification", input: changed((i) => metadata(i, { usoCfdi: "G01" })), tipoPersona: "PF", expected: { ...normal, reason: "CLASSIFICATION_REVIEW" } },
  { id: "DED-012", description: "Known zero documentary expense does not become an approved zero deduction", input: changed((i) => {
    i.parents = []; i.payments = []; i.history = []; i.issued[0].descuentoMicros = i.issued[0].subtotalMicros; i.issued[0].totalMicros = 0;
  }), tipoPersona: "PF", expected: { estado: "PROYECTABLE", totales: { pueDocumentadoCentavos: 0, ppdRepCentavos: 0 } } },
  { id: "DED-013", description: "PPD cannot borrow the payment method of its parent invoice", input: deductionEvidence(), tipoPersona: "PF", expected: { ...normal, reason: "PPD_PAYMENT_METHOD_UNAVAILABLE" } },
  { id: "DED-014", description: "RESICO PF expense evidence does not reduce monthly ISR", input: changed((i) => singleRegime(i, "626")), tipoPersona: "PF", expected: { ...normal, treatment: "RESICO_PF_SIN_DEDUCCION_ISR" } },
  { id: "DED-015", description: "RESICO PM is never routed through the PF deduction treatment", input: changed((i) => singleRegime(i, "626")), tipoPersona: "PM", expected: { ...normal, reason: "RESICO_PM_TREATMENT_REVIEW", treatment: "GASTO_POR_REVISAR" } },
  { id: "DED-016", description: "Unknown taxpayer type prevents regime-specific treatment", input: deductionEvidence(), tipoPersona: null, expected: { ...normal, treatment: "REGIMEN_POR_REVISAR" } },
  { id: "DED-017", description: "An incompatible regime/person pair remains under review", input: changed((i) => singleRegime(i, "601")), tipoPersona: "PF", expected: { ...normal, reason: "REGIME_TREATMENT_REVIEW" } },
  { id: "DED-018", description: "Rental attribution cannot invent an effective deduction election", input: deductionEvidence(), tipoPersona: "PF", expected: { ...normal, reason: "RENTAL_ELECTION_REVIEW" } },
  { id: "DED-019", description: "Platform deduction treatment requires the effective election", input: changed((i) => singleRegime(i, "625")), tipoPersona: "PF", expected: { ...normal, reason: "PLATFORM_ELECTION_REVIEW" } },
  { id: "DED-020", description: "Assisted regimes do not inherit general-business deductions", input: changed((i) => singleRegime(i, "603")), tipoPersona: "PM", expected: { ...normal, treatment: "REGIMEN_POR_REVISAR" } },
  { id: "DED-021", description: "The 2026 review checklist is not extrapolated into another year", input: changed((i) => {
    singleRegime(i, "626"); i.period = "2025-08";
    for (const row of [...i.issued, ...i.parents]) row.fecha = row.fecha.replace("2026", "2025");
    for (const row of i.history) row.fechaPago = row.fechaPago!.replace("2026", "2025");
  }), tipoPersona: "PF", expected: { ...normal, reason: "RULE_PERIOD_REVIEW", treatment: "REGIMEN_POR_REVISAR" } },
  { id: "DED-022", description: "Missing mixed-regime attribution blocks documentary aggregates", input: changed((i) => { i.parents[0].assignment = null; }), tipoPersona: "PF", expected: pending("ASSIGNMENT_REQUIRED") },
  { id: "DED-023", description: "Received linked credit notes require reviewed netting", input: changed((i) => { i.linkedCreditNoteIds = ["supplier-credit-note"]; }), tipoPersona: "PF", expected: pending("CREDIT_NOTE_REVIEW") },
  { id: "DED-024", description: "Cancelled expenses and payment receipts create no evidence", input: changed((i) => { i.issued[0].status = "CANCELLED"; i.payments[0].status = "CANCELLED"; }), tipoPersona: "PF", expected: { estado: "SIN_EVIDENCIA", totales: null } },
  { id: "DED-025", description: "Superseded stamped expenses and receipts create no evidence", input: changed((i) => { i.issued[0].supersededBy = "replacement"; i.payments[0].supersededBy = "replacement-rep"; }), tipoPersona: "PF", expected: { estado: "SIN_EVIDENCIA", totales: null } },
  { id: "DED-026", description: "Foreign currency cannot become an unreviewed MXN deduction", input: changed((i) => { i.parents[0].moneda = "USD"; }), tipoPersona: "PF", expected: pending("FOREIGN_CURRENCY_REVIEW") },
  { id: "DED-027", description: "Undated supplier payments keep aggregate evidence pending", input: changed((i) => { i.payments[0].fechaPago = null; }), tipoPersona: "PF", expected: pending("PAYMENT_DATE_UNAVAILABLE") },
  { id: "DED-028", description: "Duplicate REP import is counted once on the expense side", input: changed((i) => {
    const duplicate = { ...i.payments[0], id: "supplier-copy" }; i.payments.push(duplicate); i.history.push(duplicate);
  }), tipoPersona: "PF", expected: normal },
  { id: "DED-029", description: "No evidence yields unknown, not a zero deduction", input: changed((i) => { i.issued = []; i.parents = []; i.payments = []; i.history = []; }), tipoPersona: "PF", expected: { estado: "SIN_EVIDENCIA", totales: null } },
  { id: "DED-030", description: "Income invoices and collections cannot enter the expense summary", input: incomeEvidence(), tipoPersona: "PF", expected: { estado: "SIN_EVIDENCIA", totales: null } },
];
