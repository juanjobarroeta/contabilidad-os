// ─────────────────────────────────────────────────────────────────────────────
// Mapeo de las respuestas de Syntage a nuestros tipos de cumplimiento.
//
// ⚠️ VERIFY: las claves exactas del JSON de Syntage (tax_compliance / tax_status)
// no están en la doc pública; aquí se leen de forma defensiva, aceptando varias
// variantes. Al recibir la PRIMERA respuesta viva, ajusta estos accesos — es el
// ÚNICO punto que requiere verificación. La mecánica (auth, extracción) ya está
// confirmada en docs.
// ─────────────────────────────────────────────────────────────────────────────

import type { CsfResult, EstatusPadron, OpinionResult, ResultadoOpinion } from "../types";

type Json = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const pick = (o: Json, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] != null) return o[k];
  return undefined;
};
const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : str((x as Json)?.descripcion) ?? str((x as Json)?.name) ?? "")).filter(Boolean) : [];

function normResultado(v: unknown): ResultadoOpinion {
  const s = (str(v) ?? "").toLowerCase();
  if (/positiv/.test(s)) return "POSITIVA";
  if (/negativ/.test(s)) return "NEGATIVA";
  if (/no.?local|inscr/.test(s)) return "NO_LOCALIZADO";
  if (/sin.?oblig/.test(s)) return "SIN_OBLIGACIONES";
  return "ERROR";
}

function normEstatusPadron(v: unknown): EstatusPadron {
  const s = (str(v) ?? "").toUpperCase();
  if (s.includes("SUSP")) return "SUSPENDIDO";
  if (s.includes("CANCEL")) return "CANCELADO";
  if (s.includes("BAJA")) return "BAJA";
  if (s.includes("ACTIV")) return "ACTIVO";
  return "DESCONOCIDO";
}

/** tax_compliance → OpinionResult (SAT). */
export function mapTaxCompliance(raw: Json, fetchedAt = new Date().toISOString()): OpinionResult {
  const r = (pick(raw, "result", "data", "taxCompliance") as Json) ?? raw;
  return {
    tipo: "SAT_OPINION",
    resultado: normResultado(pick(r, "opinion", "result", "status", "opinionCumplimiento", "resultado")),
    motivos: arr(pick(r, "obligations", "obligaciones", "motivos", "reasons")),
    acuseUrl: str(pick(r, "file", "acuse", "pdf", "url")),
    vigencia: str(pick(r, "validUntil", "vigencia", "expiresAt")),
    fetchedAt,
  };
}

/** tax_status → CsfResult (CSF). */
export function mapTaxStatus(raw: Json, fetchedAt = new Date().toISOString()): CsfResult {
  const r = (pick(raw, "result", "data", "taxStatus") as Json) ?? raw;
  const dom = (pick(r, "domicilio", "address", "fiscalAddress") as Json) ?? {};
  return {
    tipo: "CSF",
    perfil: {
      rfc: str(pick(r, "rfc", "taxId")) ?? "",
      regimenes: arr(pick(r, "regimenes", "regimes", "taxRegimes")),
      obligaciones: arr(pick(r, "obligaciones", "obligations")),
      codigoPostal: str(pick(r, "codigoPostal", "postalCode")) ?? str(pick(dom, "codigoPostal", "postalCode")),
      estatusPadron: normEstatusPadron(pick(r, "estatus", "status", "padronStatus")),
    },
    acuseUrl: str(pick(r, "file", "acuse", "pdf", "url")),
    fetchedAt,
  };
}
