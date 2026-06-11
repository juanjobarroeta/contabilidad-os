import crypto from "crypto";
import { decryptSecret } from "./crypto";

// ─────────────────────────────────────────────────────────────────────────────
// FIEL (e.firma) expiry. The .cer is an X.509 certificate; its `validTo` is the
// e.firma's expiry. An expired FIEL silently breaks SAT descarga, so we surface
// "por vencer / vencida" before it bites — critical for a despacho with many RFCs.
// ─────────────────────────────────────────────────────────────────────────────

const POR_VENCER_DIAS = 30;

/** Expiry (notAfter) of a stored .cer. Accepts the encrypted-at-rest value or
 *  raw base64 DER; returns null if unparseable / key not configured. */
export function parseCertExpiry(storedOrRawCer: string): Date | null {
  try {
    const der = Buffer.from(decryptSecret(storedOrRawCer), "base64");
    const cert = new crypto.X509Certificate(der);
    const d = new Date(cert.validTo); // e.g. "Jun 10 23:59:59 2030 GMT"
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

export type FielEstado = "ok" | "por_vencer" | "vencida" | "sin_fiel";

export interface FielStatus {
  estado: FielEstado;
  vigencia: string | null; // ISO
  diasRestantes: number | null;
}

/** Status for a company. Uses the stored fielVigencia if present, else parses
 *  the cert live (so existing companies without a stored date still get a
 *  correct warning — no backfill required). */
export function fielStatus(company: { fielCer: string | null; fielVigencia: Date | null }): FielStatus {
  if (!company.fielCer) return { estado: "sin_fiel", vigencia: null, diasRestantes: null };
  const expiry = company.fielVigencia ?? parseCertExpiry(company.fielCer);
  if (!expiry) return { estado: "ok", vigencia: null, diasRestantes: null };
  const dias = Math.floor((expiry.getTime() - Date.now()) / 86_400_000);
  const estado: FielEstado = dias < 0 ? "vencida" : dias <= POR_VENCER_DIAS ? "por_vencer" : "ok";
  return { estado, vigencia: expiry.toISOString(), diasRestantes: dias };
}
