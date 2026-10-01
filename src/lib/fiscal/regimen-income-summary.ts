import { summarizeRegimenDocumentBases, type RegimenDocumentInput, type RegimenDocumentSummary } from "./regimen-document-bases";

export {
  decimalToSafeMicros,
  type RegimenInvoiceEvidence as IncomeInvoiceEvidence,
  type RegimenPaymentEvidence as IncomePaymentEvidence,
  type RegimenDocumentIssueCode as IncomeSummaryIssueCode,
  type RegimenDocumentInput as RegimenIncomeInput,
  type RegimenDocumentIssue as IncomeSummaryIssue,
  type RegimenDocumentRow as IncomeSummaryRow,
} from "./regimen-document-bases";

export interface RegimenIncomeSummary extends RegimenDocumentSummary {
  pueAcreditaCobro: false;
}

/** Stable FISC-002M contract; opposite-direction expenses never enter income. */
export function summarizeRegimenIncome(input: RegimenDocumentInput): RegimenIncomeSummary {
  return { ...summarizeRegimenDocumentBases(input, "INGRESO"), pueAcreditaCobro: false };
}
