// ─────────────────────────────────────────────────────────────────────────────
// ComplianceProvider — la frontera del "fetch". El núcleo (diff/alertas) es
// agnóstico de cómo se obtienen los documentos. La implementación real va detrás
// de esta interfaz:
//   • In-house: automatización del portal SAT/IMSS con la e.firma/CIEC
//     (headless browser) — frágil, requiere navegador real + credenciales vivas.
//   • Agregador: Syntage / SW / Belvo Fiscal con CIEC/e.firma.
// Así el motor de alertas no cambia según el proveedor elegido.
// ─────────────────────────────────────────────────────────────────────────────

import type { CsfResult, OpinionResult } from "./types";

export interface ComplianceProvider {
  /** Opinión de cumplimiento del SAT (32-D). */
  fetchSatOpinion(companyId: string): Promise<OpinionResult>;
  /** Opinión de cumplimiento de obligaciones de seguridad social (IMSS). */
  fetchImssOpinion(companyId: string): Promise<OpinionResult>;
  /** Constancia de Situación Fiscal (incluye la cédula/CIF). */
  fetchCsf(companyId: string): Promise<CsfResult>;
}

/** Lanzada por implementaciones aún no disponibles en un entorno dado. */
export class ComplianceProviderNoDisponible extends Error {
  constructor(metodo: string) {
    super(`ComplianceProvider.${metodo} no está implementado en este entorno.`);
    this.name = "ComplianceProviderNoDisponible";
  }
}
