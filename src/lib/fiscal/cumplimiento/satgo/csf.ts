// ─────────────────────────────────────────────────────────────────────────────
// Constancia de Situación Fiscal (PDF del SAT) → CsfPerfil. El estatus en el
// padrón y el CP se leen del texto (deterministas); los regímenes con CLAVE
// (601, 626…) y las obligaciones salen del mismo parser de Claude que usa el
// onboarding (parseSatDocument), porque la constancia imprime el NOMBRE del
// régimen, no la clave. Una llamada por constancia; la CSF se pide poco.
// ─────────────────────────────────────────────────────────────────────────────

import { parseSatDocument, type CsfData } from "@/lib/fiscal/acuse/parse";
import type { CostCtx } from "@/lib/costos/record";
import { textoDePdf } from "../../fuentes/texto";
import type { CsfPerfil, EstatusPadron } from "../types";

const normalizar = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

/** «Estatus en el padrón: ACTIVO» → ACTIVO; sin renglón → DESCONOCIDO. */
export function estatusPadronDeTexto(texto: string): EstatusPadron {
  const t = normalizar(texto).toUpperCase();
  const m = t.match(/ESTATUS\s+(?:EN\s+EL\s+PADRON|DEL\s+CONTRIBUYENTE)?\s*[:.]?\s*(ACTIVO|SUSPENDIDO|CANCELADO|BAJA|REACTIVADO)/);
  if (!m) return "DESCONOCIDO";
  if (m[1] === "REACTIVADO") return "ACTIVO";
  return m[1] as EstatusPadron;
}

/** «Código Postal: 72000» → «72000», o null. */
export function codigoPostalDeTexto(texto: string): string | null {
  const m = normalizar(texto).match(/C[OÓ]DIGO\s+POSTAL\s*[:.]?\s*(\d{5})/i);
  return m ? m[1] : null;
}

/** «RFC: ABC120101AAA» → RFC, o null. */
export function rfcDeTexto(texto: string): string | null {
  const m = normalizar(texto).toUpperCase().match(/\bRFC\s*[:.]?\s*([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})\b/);
  return m ? m[1] : null;
}

/** Clave de régimen normalizada a 3 dígitos («601»), o null si no es clave. */
function claveRegimen(code: unknown): string | null {
  const s = String(code ?? "").trim();
  return /^\d{3}$/.test(s) ? s : null;
}

/** CsfData (Claude) + texto → perfil comparable con el que daba Syntage. */
export function perfilDesdeCsfData(csf: CsfData | null, texto: string, rfcEsperado: string): CsfPerfil {
  const regimenes = Array.from(new Set((csf?.regimenes ?? []).map((r) => claveRegimen(r.code)).filter((c): c is string => !!c))).sort();
  const obligaciones = Array.from(new Set((csf?.obligaciones ?? []).map((o) => o.replace(/\s+/g, " ").trim()).filter(Boolean))).sort();
  return {
    rfc: (csf?.rfc ?? rfcDeTexto(texto) ?? rfcEsperado).toUpperCase(),
    regimenes,
    obligaciones,
    codigoPostal: csf?.codigoPostal ?? codigoPostalDeTexto(texto) ?? undefined,
    estatusPadron: estatusPadronDeTexto(texto),
  };
}

export class CsfNoReconocidaError extends Error {
  constructor(readonly tipoDetectado: string) {
    super(`El documento no se reconoció como Constancia de Situación Fiscal (Claude lo clasificó como ${tipoDetectado}).`);
    this.name = "CsfNoReconocidaError";
  }
}

/** PDF de la CSF → perfil. Lanza CsfNoReconocidaError si el PDF no es una constancia. */
export async function csfDesdePdf(pdf: Buffer, rfcEsperado: string, cost?: CostCtx): Promise<{ perfil: CsfPerfil; texto: string }> {
  let texto = "";
  try { texto = await textoDePdf(pdf); } catch { /* sin texto: Claude lee el PDF igual */ }
  const parsed = await parseSatDocument(pdf.toString("base64"), { ...cost, subtipo: cost?.subtipo ?? "cumplimiento.csf.satgo" });
  if (parsed.type !== "CSF" || !parsed.csf) throw new CsfNoReconocidaError(parsed.type);
  return { perfil: perfilDesdeCsfData(parsed.csf, texto, rfcEsperado), texto };
}
