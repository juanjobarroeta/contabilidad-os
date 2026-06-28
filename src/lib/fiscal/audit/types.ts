// ─────────────────────────────────────────────────────────────────────────────
// Auditor — the "24/7 contador". Runs declarative checks against a company's
// normalized CFDIs and raises findings (Hallazgos) with a suggested fix and a
// citation. Checks pull their thresholds from the rules layer (getRule), so the
// auditor hardcodes no fiscal constant. Contract: docs/fiscal-brain-contract.md
// ─────────────────────────────────────────────────────────────────────────────

import type { Aplicabilidad, Contexto, Fundamento } from "../rules";

export type Severidad = "info" | "warn" | "error";

/** Emitida = ingreso del contribuyente; Recibida = posible deducción. */
export type Direccion = "EMITIDA" | "RECIBIDA";

export interface CfdiItem {
  /** SAT ClaveProdServ del concepto. */
  claveProdServ: string;
  descripcion?: string;
}

/**
 * Minimal normalized CFDI the auditor reasons over — decoupled from Prisma so
 * checks stay pure and testable. The Prisma adapter (from-prisma.ts) maps real
 * Invoice rows into this shape.
 */
export interface CfdiNormalizado {
  id: string;
  direccion: Direccion;
  fecha: string; // ISO
  /** SAT c_FormaPago key — "01" = Efectivo. */
  formaPago: string;
  /** Total del comprobante (MXN). */
  total: number;
  items: CfdiItem[];
  /** IVA trasladado (MXN), si se conoce — usado por checks de IVA. */
  ivaTrasladado?: number;
  /** Moneda del CFDI (SAT c_Moneda); "MXN" por defecto. */
  moneda?: string;
  /** Tipo de cambio a MXN declarado en el CFDI (1 para MXN). */
  tipoCambio?: number;
}

export interface Hallazgo {
  checkClave: string;
  severidad: Severidad;
  mensaje: string;
  /** ids de los CFDIs involucrados. */
  referencias: string[];
  /**
   * Identidad estable del hallazgo (override del dedupe). Por defecto la identidad
   * se deriva de `referencias`; los checks AGREGADOS (un solo hallazgo por empresa
   * que resume N CFDIs) fijan un `dedupeRef` constante para que el conteo cambie
   * sin crear/cerrar el hallazgo —preservando posponer/resolver del usuario.
   */
  dedupeRef?: string;
  fundamento: Fundamento;
  sugerencia: string;
}

export interface FiscalCheck {
  clave: string;
  descripcion: string;
  aplicabilidad: Aplicabilidad;
  severidad: Severidad;
  fundamento: Fundamento;
  sugerencia: string;
  /** Pure evaluation: returns the offending CFDIs as Hallazgos. */
  evaluar: (cfdis: CfdiNormalizado[], ctx: Contexto) => Hallazgo[];
}
