// ─────────────────────────────────────────────────────────────────────────────
// COE M4 — decisión Normal vs Complementaria.
//
// El SAT pide TipoEnvio="C" + FechaModBal cuando se re-envía una balanza que
// CAMBIÓ respecto al envío anterior. Guardamos un hash del contenido por periodo
// (CoeEnvio) y comparamos: si cambió → complementaria con FechaModBal = hoy.
//
// Lógica pura y testeable; la persistencia vive en coe-xml.generateBalanzaXml.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import type { BalanzaCuentaInput } from "./coe-xml";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Hash estable del contenido de la balanza (magnitudes emitidas, orden por cuenta). */
export function hashBalanza(cuentas: BalanzaCuentaInput[]): string {
  const canon = cuentas
    .map((c) => ({
      numCta: c.numCta,
      ini: r2(Math.abs(c.saldoInicial)),
      debe: r2(c.cargos),
      haber: r2(c.abonos),
      fin: r2(Math.abs(c.saldoFinal)),
    }))
    .filter((c) => c.ini !== 0 || c.debe !== 0 || c.haber !== 0 || c.fin !== 0)
    .sort((a, b) => a.numCta.localeCompare(b.numCta));
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

export interface EnvioPrevio {
  contenidoHash: string;
  tipoEnvio: string; // "N" | "C"
  fechaModBal: string | null;
}

export interface DecisionEnvio {
  tipoEnvio: "N" | "C";
  fechaModBal: string | null;
}

/**
 * Decide el tipo de envío:
 *   • sin envío previo            → N
 *   • mismo contenido que el previo → se mantiene el tipo previo (re-descarga)
 *   • contenido distinto al previo  → C (complementaria) con FechaModBal = hoy
 */
export function decidirEnvio(previo: EnvioPrevio | null, nuevoHash: string, hoy: string): DecisionEnvio {
  if (!previo) return { tipoEnvio: "N", fechaModBal: null };
  if (previo.contenidoHash === nuevoHash) {
    return { tipoEnvio: previo.tipoEnvio === "C" ? "C" : "N", fechaModBal: previo.fechaModBal };
  }
  return { tipoEnvio: "C", fechaModBal: hoy };
}
