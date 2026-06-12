// ─────────────────────────────────────────────────────────────────────────────
// Fiscal rules — structured layer of the "brain".
//
// The narrative layer (src/lib/fiscal-kb) answers in prose for the assistant and
// humans. THIS layer answers in typed data so the engine and the auditor can
// branch on it deterministically. The contract is docs/fiscal-brain-contract.md.
//
// Governing principle: consumers hardcode no fiscal constant — every value and
// applicability decision is resolved here, as of a date. Same discipline as
// tarifas.ts: versioned, git-tracked, vigencia + `verificado` provenance, so the
// fiscal-monitoring agent maintains it via reviewable PRs.
// ─────────────────────────────────────────────────────────────────────────────

/** Sector / actividad económica tags. "GENERAL" is implicit via aplicabilidad "*". */
export type Sector =
  | "CONSTRUCCION"
  | "AGAPES"
  | "AUTOTRANSPORTE"
  | "INDUSTRIA"
  | "JOYERIA"
  | "RESTAURANTES"
  | "ARRENDAMIENTO"
  | "PLATAFORMAS"
  | "EXPORTACION";

export type TipoPersona = "PF" | "PM";

/**
 * Entidad federativa (SAT c_Estado codes). The jurisdiction dimension: state
 * taxes (ISN, hospedaje, cedulares) vary by entidad. Federal rules leave
 * `entidad` as "*"/undefined.
 */
export type Entidad =
  | "AGU" | "BCN" | "BCS" | "CAM" | "CHP" | "CHH" | "CMX" | "COA" | "COL"
  | "DUR" | "GUA" | "GRO" | "HID" | "JAL" | "MEX" | "MIC" | "MOR" | "NAY"
  | "NLE" | "OAX" | "PUE" | "QUE" | "ROO" | "SLP" | "SIN" | "SON" | "TAB"
  | "TAM" | "TLA" | "VER" | "YUC" | "ZAC";

/** Who/when a rule applies. "*" = applies regardless of that dimension. */
export interface Aplicabilidad {
  /** SAT régimen codes (e.g. ["601","626"]) or "*". */
  regimenes: string[] | "*";
  /** Sector tags that must intersect the company's, or "*". */
  actividades: Sector[] | "*";
  tipoPersona: TipoPersona | "*";
  /**
   * Entidades federativas a rule applies to, or "*"/undefined for federal (any
   * state). A state-specific rule only matches when the context's entidad is
   * known and listed.
   */
  entidad?: Entidad[] | "*";
}

/** Pointer back to the citable narrative chunk a rule was distilled from. */
export interface Fundamento {
  ley: string; // "LISR" | "LIVA" | "CFF" | "RMF" | "RFA" | "LFPIORPI" | …
  articulo: string;
  fraccion?: string;
  /** Narrative-layer chunk id; populated once cross-linked to the KB. */
  chunkId?: string;
}

export type TipoRegla =
  | "RATE" // tasa / porcentaje
  | "CAP" // tope máximo
  | "THRESHOLD" // umbral
  | "EXEMPTION" // exención (valor boolean)
  | "DEPRECIATION" // tabla de tasas de depreciación
  | "OBLIGATION"; // requisito / obligación (valor boolean)

/** A table value keys an asset/concept → number (e.g. depreciation rates). */
export type Tabla = Record<string, number>;
export type ValorRegla = number | boolean | string | Tabla;

export interface FiscalRule {
  /** Stable semantic key, e.g. "isr.deduccion.auto.tope_moi". */
  clave: string;
  tipo: TipoRegla;
  valor: ValorRegla;
  unidad?: "MXN" | "porcentaje" | "UMA" | "dias" | "veces_salario";
  aplicabilidad: Aplicabilidad;
  /** ISO date, inclusive. */
  vigenciaDesde: string;
  /** ISO date, inclusive; null = open-ended. */
  vigenciaHasta: string | null;
  fundamento: Fundamento;
  /** True once checked against the authoritative published source. */
  verificado: boolean;
  /** Optional caveat (e.g. "progresivo", "+1% sobretasa") surfaced to consumers. */
  nota?: string;
}

/** The company context a rule is resolved against. */
export interface Contexto {
  regimen: string;
  actividades: Sector[];
  tipoPersona: TipoPersona;
  /** Entidad federativa, when known — gates state-specific rules. */
  entidad?: Entidad;
  /** ISO date; selects the vigencia in force. */
  fecha: string;
}

/** Result of resolving a single rule. */
export interface ReglaResuelta<V extends ValorRegla = ValorRegla> {
  clave: string;
  valor: V;
  unidad?: FiscalRule["unidad"];
  fundamento: Fundamento;
  /** Propagated so a consumer never silently trusts an unverified figure. */
  verificado: boolean;
  /** Caveat from the rule (e.g. "progresivo", "+1% sobretasa"), if any. */
  nota?: string;
}
