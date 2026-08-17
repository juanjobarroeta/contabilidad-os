// ─────────────────────────────────────────────────────────────────────────────
// PacProvider — la frontera del "timbrado". El núcleo de la app (persistencia
// de facturas, conciliación, impuestos) es agnóstico de QUÉ PAC emite el CFDI.
// La implementación real (Facturapi hoy; SW sapien / Facturama / Finkok mañana)
// vive detrás de esta interfaz, igual que ComplianceProvider para datos del SAT.
//
// Esto es lo único que ata la app a Facturapi: el timbrado es un commodity
// (hay 70+ PACs autorizados sobre el mismo estándar CFDI), así que mantener el
// borde explícito permite comparar precio/servicio y migrar sin reescribir las
// reglas de negocio.
//
// Tipos en términos CFDI/SAT (no propietarios de Facturapi) salvo `customerRef`
// y `pacId`, que son referencias opacas del PAC en turno.
// ─────────────────────────────────────────────────────────────────────────────

export type PacErrorKind =
  | "auth" // clave muerta / sin permisos
  | "validation" // datos del CFDI/receptor incorrectos
  | "not_found"
  | "rate_limit"
  | "server" // el PAC está caído
  | "unknown";

/** Una línea (concepto) del CFDI, en claves SAT. */
export interface CfdiLineItem {
  quantity: number;
  product: {
    description: string;
    product_key: string; // clave SAT producto/servicio (c_ClaveProdServ)
    price: number;
    unit_key?: string; // clave SAT unidad (c_ClaveUnidad)
    tax_included?: boolean;
    taxes?: Array<{ type: string; rate: number; factor: string; withholding?: boolean }>;
  };
}

/** Datos neutrales para emitir un CFDI de ingreso. */
export interface CfdiInput {
  /** TipoDeComprobante: "I" (default) o "E" (egreso / nota de credito). */
  type?: "I" | "E";
  /** CFDI relacionados (p.ej. relacion "01" = nota de credito del documento). */
  relations?: { relationship: string; documents: string[] };
  /** Referencia del receptor en el PAC (hoy: el customer id de Facturapi). */
  customerRef: string;
  /**
   * Datos completos del receptor en línea. Facturapi los ignora (usa
   * customerRef contra su catálogo); los PACs sin catálogo (SW sapien, Finkok)
   * los necesitan en el CFDI. Opcional para no romper llamadas existentes.
   */
  receptor?: {
    rfc: string;
    nombre: string;
    regimenFiscal: string; // c_RegimenFiscal del receptor
    domicilioFiscalCP: string; // CP fiscal del receptor
  };
  paymentForm: string; // c_FormaPago
  paymentMethod: "PUE" | "PPD";
  use: string; // c_UsoCFDI
  items: CfdiLineItem[];
  notes?: string;
  /** Información Global (Público General / RFC genérico). */
  global?: {
    periodicity: "day" | "week" | "fortnight" | "month" | "two_months";
    months: string;
    year: number;
  };
}

/** CFDI ya timbrado, normalizado entre PACs. */
export interface StampedCfdi {
  /** Id del CFDI del lado del PAC (se guarda en Invoice.facturapiId). */
  pacId: string;
  uuid: string | null;
  total?: number;
  subtotal?: number;
  folio?: number | null;
}

/** Resultado de provisionar la organización/CSD del emisor en el PAC. */
export interface OrgProvisionResult {
  ok: boolean;
  orgId: string | null;
  csdUploaded: boolean;
  hasLiveKey: boolean;
  warning?: string;
  error?: string;
}

export type PacOutcome<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: number;
      message: string;
      kind: PacErrorKind;
      needsReconfigure: boolean;
    };

/**
 * Credencial del PAC de la empresa. `apiKey` viaja CIFRADA tal como está en
 * reposo; el provider la abre vía la bóveda (src/lib/vault.ts, V-1) — por eso
 * el companyId viaja junto: sin él no hay bitácora de a QUIÉN se le usó la
 * llave. `actor` es opcional ("timbrado", "route:...", default "sistema").
 */
export interface PacCredencial {
  apiKey: string;
  companyId: string;
  actor?: string;
}

export interface PacProvider {
  /** Nombre del PAC activo (para logs/telemetría). */
  readonly name: string;

  /** Timbra un CFDI de ingreso directamente. */
  createCfdi(pac: PacCredencial, input: CfdiInput): Promise<PacOutcome<StampedCfdi>>;

  /** Crea un borrador (no consume timbre) para previsualizar antes de timbrar. */
  createDraft(pac: PacCredencial, input: CfdiInput): Promise<PacOutcome<{ draftId: string }>>;

  /** Promueve un borrador existente a CFDI timbrado. */
  stampDraft(pac: PacCredencial, draftId: string): Promise<PacOutcome<StampedCfdi>>;

  /** Borra un borrador sin timbrar (best-effort, nunca lanza). */
  discardDraft(pac: PacCredencial, draftId: string): Promise<void>;

  /** Cancela un CFDI timbrado ante el SAT, con motivo (y sustitución si motivo 01). */
  cancelCfdi(
    pac: PacCredencial,
    pacId: string,
    motivo: string,
    sustituyeUuid?: string
  ): Promise<PacOutcome<void>>;

  /** Provisiona el emisor en el PAC (org + datos legales + CSD + llave live). */
  provisionOrg(companyId: string): Promise<OrgProvisionResult>;
}
