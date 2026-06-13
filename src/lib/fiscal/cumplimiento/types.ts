// ─────────────────────────────────────────────────────────────────────────────
// Monitoreo de cumplimiento — tipos. Opiniones de cumplimiento (SAT 32-D e IMSS
// OCOFSS) y Constancia de Situación Fiscal (CSF). El "fetch" real vive detrás de
// ComplianceProvider (provider.ts); este módulo solo modela los resultados y la
// detección de cambios → Hallazgos.
// ─────────────────────────────────────────────────────────────────────────────

export type TipoCumplimiento = "SAT_OPINION" | "IMSS_OPINION" | "CSF";

/** Resultado de una opinión de cumplimiento. */
export type ResultadoOpinion =
  | "POSITIVA"
  | "NEGATIVA"
  | "NO_LOCALIZADO" // RFC no localizado / sin opinión emitida
  | "SIN_OBLIGACIONES"
  | "ERROR";

export interface OpinionResult {
  tipo: "SAT_OPINION" | "IMSS_OPINION";
  resultado: ResultadoOpinion;
  /** Obligaciones omitidas / motivos de la negativa. */
  motivos: string[];
  /** PDF/acuse de respaldo. */
  acuseUrl?: string;
  /** Vigencia de la opinión (ISO). */
  vigencia?: string;
  /** Cuándo se obtuvo (ISO). */
  fetchedAt: string;
}

/** Estatus del contribuyente en el padrón (de la CSF). */
export type EstatusPadron = "ACTIVO" | "SUSPENDIDO" | "CANCELADO" | "BAJA" | "DESCONOCIDO";

export interface CsfPerfil {
  rfc: string;
  /** Claves de régimen SAT (601, 612, 626…). */
  regimenes: string[];
  /** Descripciones de obligaciones registradas. */
  obligaciones: string[];
  codigoPostal?: string;
  estatusPadron: EstatusPadron;
}

export interface CsfResult {
  tipo: "CSF";
  perfil: CsfPerfil;
  acuseUrl?: string;
  fetchedAt: string;
}

export type ComplianceResult = OpinionResult | CsfResult;

/** Snapshot persistido (espejo del modelo Prisma ComplianceSnapshot). */
export interface ComplianceSnapshot {
  tipo: TipoCumplimiento;
  resultado: string;
  motivos: string[];
  perfil?: CsfPerfil | null;
  contenidoHash: string;
  acuseUrl?: string | null;
  vigencia?: string | null;
  fetchedAt: string;
}
