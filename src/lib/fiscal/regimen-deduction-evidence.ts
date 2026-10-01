import { readRegimenDocumentEvidence } from "./regimen-document-evidence";
import { summarizeRegimenDeductions } from "./regimen-deduction-summary";

export { DOCUMENT_EVIDENCE_LIMIT as DEDUCTION_EVIDENCE_LIMIT } from "./regimen-document-evidence";

/** Caller must authorize company membership. Read-only, no tax calculation. */
export async function readRegimenDeductionEvidence(companyId: string, year: number, month: number) {
  const snapshot = await readRegimenDocumentEvidence(companyId, year, month, "EGRESO");
  return snapshot ? summarizeRegimenDeductions(snapshot.input, snapshot.tipoPersona) : null;
}
