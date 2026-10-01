import { readRegimenDocumentEvidence } from "./regimen-document-evidence";
import { summarizeRegimenIncome } from "./regimen-income-summary";

export { DOCUMENT_EVIDENCE_LIMIT as INCOME_EVIDENCE_LIMIT } from "./regimen-document-evidence";

/** Caller must authorize company membership. No calculation or write. */
export async function readRegimenIncomeEvidence(companyId: string, year: number, month: number) {
  const snapshot = await readRegimenDocumentEvidence(companyId, year, month, "INGRESO");
  return snapshot ? summarizeRegimenIncome(snapshot.input) : null;
}
