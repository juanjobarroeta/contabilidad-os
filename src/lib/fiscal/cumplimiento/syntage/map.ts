// ─────────────────────────────────────────────────────────────────────────────
// Mapeo de los RECURSOS de resultado de Syntage a nuestros tipos. Confirmado
// contra el OpenAPI de Syntage y una respuesta viva:
//   TaxComplianceCheck.result ∈ positive|negative|no_obligations|activity_suspended
//   TaxStatus → rfc, taxRegimes[].code, obligations[].description, address.postalCode, status
// OJO: estos son los recursos /tax-compliance-checks/{id} y /tax-status/{id},
// NO el objeto Extraction (que es sólo el job).
// ─────────────────────────────────────────────────────────────────────────────

import type { CsfResult, EstatusPadron, OpinionResult, ResultadoOpinion } from "../types";

type Json = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const fileRef = (f: unknown): string | undefined => {
  if (typeof f === "string") return f;
  if (f && typeof f === "object") return str((f as Json).resource) ?? str((f as Json)["@id"]);
  return undefined;
};

function mapResult(v: unknown): ResultadoOpinion {
  switch (String(v)) {
    case "positive":
      return "POSITIVA";
    case "negative":
      return "NEGATIVA";
    case "no_obligations":
      return "SIN_OBLIGACIONES";
    case "activity_suspended":
      return "NO_LOCALIZADO"; // suspendido: sin opinión vigente
    default:
      return "ERROR";
  }
}

function mapEstatus(v: unknown): EstatusPadron {
  const s = (str(v) ?? "").toUpperCase();
  if (s.includes("SUSP")) return "SUSPENDIDO";
  if (s.includes("CANCEL")) return "CANCELADO";
  if (s.includes("BAJA")) return "BAJA";
  if (s.includes("ACTIV")) return "ACTIVO";
  return "DESCONOCIDO";
}

/** Recurso TaxComplianceCheck → OpinionResult (SAT). */
export function mapTaxCompliance(check: Json, fetchedAt = new Date().toISOString()): OpinionResult {
  const folio = str(check.internalIdentifier);
  return {
    tipo: "SAT_OPINION",
    resultado: mapResult(check.result),
    // El detalle de la negativa vive en el PDF; conservamos el folio del SAT.
    motivos: folio ? [`Folio SAT: ${folio}`] : [],
    acuseUrl: fileRef(check.file),
    vigencia: str(check.checkedAt),
    fetchedAt,
  };
}

/** Recurso TaxStatus → CsfResult (CSF). */
export function mapTaxStatus(ts: Json, fetchedAt = new Date().toISOString()): CsfResult {
  const address = (ts.address as Json) ?? {};
  const regimes = Array.isArray(ts.taxRegimes) ? (ts.taxRegimes as Json[]) : [];
  const obligations = Array.isArray(ts.obligations) ? (ts.obligations as Json[]) : [];
  return {
    tipo: "CSF",
    perfil: {
      rfc: str(ts.rfc) ?? "",
      regimenes: regimes.map((r) => String(r.code ?? "")).filter(Boolean),
      obligaciones: obligations.map((o) => str(o.description) ?? "").filter(Boolean),
      codigoPostal: str(address.postalCode),
      estatusPadron: mapEstatus(ts.status),
    },
    acuseUrl: fileRef(ts.file),
    fetchedAt,
  };
}
