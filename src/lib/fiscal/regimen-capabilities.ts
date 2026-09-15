/**
 * Product capability registry for the SAT CFDI 4.0 regimen catalog.
 *
 * Recognition is deliberately separate from calculation support. A regimen can
 * be accepted from a CSF and still require an accountant-assisted calculation.
 * Calculation callers must use the guards below; branching on PF/PM alone is
 * unsafe because it substitutes another regimen's formula.
 */

export const REGIMEN_CODES = [
  "601", "603", "605", "606", "607", "608", "610", "611", "612", "614",
  "615", "616", "620", "621", "622", "623", "624", "625", "626",
] as const;

export type RegimenCode = (typeof REGIMEN_CODES)[number];
export type TipoPersonaFiscal = "PF" | "PM";

export const REGIMEN_LABELS: Readonly<Record<string, string>> = {
  "601": "General de Ley Personas Morales",
  "603": "Personas Morales con Fines no Lucrativos",
  "605": "Sueldos y Salarios e Ingresos Asimilados a Salarios",
  "606": "Arrendamiento",
  "607": "Régimen de Enajenación o Adquisición de Bienes",
  "608": "Demás ingresos",
  "610": "Residentes en el Extranjero sin Establecimiento Permanente en México",
  "611": "Ingresos por Dividendos (socios y accionistas)",
  "612": "Personas Físicas con Actividades Empresariales y Profesionales",
  "614": "Ingresos por intereses",
  "615": "Régimen de los ingresos por obtención de premios",
  "616": "Sin obligaciones fiscales",
  "620": "Sociedades Cooperativas de Producción que optan por diferir sus ingresos",
  "621": "Incorporación Fiscal",
  "622": "Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras",
  "623": "Opcional para Grupos de Sociedades",
  "624": "Coordinados",
  "625": "Régimen de las Actividades Empresariales con ingresos a través de Plataformas Tecnológicas",
  "626": "Régimen Simplificado de Confianza",
} satisfies Record<RegimenCode, string>;

export const VALID_REGIMENES: ReadonlySet<string> = new Set(REGIMEN_CODES);

export const REGIMEN_TRACK_IDS = [
  "601", "603", "605", "606", "607", "608", "610", "611", "612", "614",
  "615", "616", "620", "621", "622", "623", "624", "625", "626-PF", "626-PM",
] as const;

export type RegimenTrackId = (typeof REGIMEN_TRACK_IDS)[number];
export type CapabilityStatus =
  | "SUPPORTED"
  | "PARTIAL"
  | "ASSISTED"
  | "NOT_APPLICABLE"
  | "NOT_SUPPORTED";

export interface RegimenCapability {
  trackId: RegimenTrackId;
  code: RegimenCode;
  label: string;
  taxpayerTypes: readonly TipoPersonaFiscal[];
  capabilities: {
    catalog: CapabilityStatus;
    calendar: CapabilityStatus;
    monthly: CapabilityStatus;
    annual: CapabilityStatus;
    accounting: CapabilityStatus;
    filing: CapabilityStatus;
    qa: CapabilityStatus;
  };
}

type CapabilityFlags = RegimenCapability["capabilities"];

const flags = (
  monthly: CapabilityStatus,
  annual: CapabilityStatus,
  options: Partial<CapabilityFlags> = {},
): CapabilityFlags => ({
  catalog: "SUPPORTED",
  calendar: "PARTIAL",
  monthly,
  annual,
  accounting: "PARTIAL",
  filing: monthly === "PARTIAL" ? "PARTIAL" : "ASSISTED",
  qa: monthly === "PARTIAL" || annual === "PARTIAL" ? "PARTIAL" : "NOT_SUPPORTED",
  ...options,
});

const capability = (
  trackId: RegimenTrackId,
  code: RegimenCode,
  taxpayerTypes: readonly TipoPersonaFiscal[],
  capabilities: CapabilityFlags,
): RegimenCapability => ({
  trackId,
  code,
  label: REGIMEN_LABELS[code],
  taxpayerTypes,
  capabilities,
});

/**
 * Exactly 20 product tracks: the 19 current catalog codes, with 626 split into
 * independent PF and PM calculation tracks.
 */
export const REGIMEN_CAPABILITIES = {
  "601": capability("601", "601", ["PM"], flags("PARTIAL", "PARTIAL")),
  "603": capability("603", "603", ["PM"], flags("ASSISTED", "ASSISTED")),
  "605": capability("605", "605", ["PF"], flags("NOT_APPLICABLE", "ASSISTED")),
  "606": capability("606", "606", ["PF"], flags("PARTIAL", "ASSISTED")),
  "607": capability("607", "607", ["PF"], flags("ASSISTED", "ASSISTED")),
  "608": capability("608", "608", ["PF"], flags("ASSISTED", "ASSISTED")),
  "610": capability("610", "610", ["PF", "PM"], flags("ASSISTED", "NOT_APPLICABLE")),
  "611": capability("611", "611", ["PF"], flags("NOT_APPLICABLE", "ASSISTED")),
  "612": capability("612", "612", ["PF"], flags("PARTIAL", "PARTIAL")),
  "614": capability("614", "614", ["PF"], flags("NOT_APPLICABLE", "ASSISTED")),
  "615": capability("615", "615", ["PF"], flags("ASSISTED", "ASSISTED")),
  "616": capability("616", "616", ["PF"], flags("NOT_APPLICABLE", "NOT_APPLICABLE", {
    calendar: "NOT_APPLICABLE",
    accounting: "NOT_APPLICABLE",
    filing: "NOT_APPLICABLE",
  })),
  "620": capability("620", "620", ["PM"], flags("ASSISTED", "ASSISTED")),
  "621": capability("621", "621", ["PF"], flags("ASSISTED", "ASSISTED")),
  "622": capability("622", "622", ["PF", "PM"], flags("ASSISTED", "ASSISTED")),
  "623": capability("623", "623", ["PM"], flags("ASSISTED", "ASSISTED")),
  "624": capability("624", "624", ["PM"], flags("ASSISTED", "ASSISTED")),
  "625": capability("625", "625", ["PF"], flags("PARTIAL", "ASSISTED")),
  "626-PF": capability("626-PF", "626", ["PF"], flags("PARTIAL", "NOT_APPLICABLE")),
  "626-PM": capability("626-PM", "626", ["PM"], flags("NOT_SUPPORTED", "ASSISTED")),
} satisfies Record<RegimenTrackId, RegimenCapability>;

export type CalculationKind = "MONTHLY" | "ANNUAL";
export type CapabilityFailureReason =
  | "UNKNOWN_REGIME"
  | "UNKNOWN_TAXPAYER_TYPE"
  | "INCOMPATIBLE_TAXPAYER_TYPE"
  | "MULTI_REGIME_COMPOSITION_REQUIRED"
  | "ASSISTED_ONLY"
  | "NOT_APPLICABLE"
  | "ENGINE_NOT_IMPLEMENTED";

export interface RegimenResolutionSuccess {
  ok: true;
  capability: RegimenCapability;
}

export interface RegimenResolutionFailure {
  ok: false;
  reason: Extract<
    CapabilityFailureReason,
    "UNKNOWN_REGIME" | "UNKNOWN_TAXPAYER_TYPE" | "INCOMPATIBLE_TAXPAYER_TYPE"
  >;
  code: string | null;
  tipoPersona: TipoPersonaFiscal | null;
  capability: RegimenCapability | null;
}

export type RegimenResolution = RegimenResolutionSuccess | RegimenResolutionFailure;

function normalizedRegimenCode(value: string | null | undefined): string | null {
  const code = value?.trim() ?? "";
  return code || null;
}

export function tipoPersonaFromRfc(rfc: string | null | undefined): TipoPersonaFiscal | null {
  const length = rfc?.trim().length ?? 0;
  if (length === 12) return "PM";
  if (length === 13) return "PF";
  return null;
}

export function resolveRegimenTrack(
  regimenFiscal: string | null | undefined,
  tipoPersona: TipoPersonaFiscal | null,
): RegimenResolution {
  const code = normalizedRegimenCode(regimenFiscal);
  if (!code || !VALID_REGIMENES.has(code)) {
    return { ok: false, reason: "UNKNOWN_REGIME", code, tipoPersona, capability: null };
  }
  if (!tipoPersona) {
    return { ok: false, reason: "UNKNOWN_TAXPAYER_TYPE", code, tipoPersona: null, capability: null };
  }

  const trackId: RegimenTrackId = code === "626" ? `626-${tipoPersona}` : code as RegimenTrackId;
  const capability = REGIMEN_CAPABILITIES[trackId];
  if (!capability.taxpayerTypes.includes(tipoPersona)) {
    return { ok: false, reason: "INCOMPATIBLE_TAXPAYER_TYPE", code, tipoPersona, capability };
  }
  return { ok: true, capability };
}

export interface RegimenCalculationDescriptor {
  code: string | null;
  trackId: RegimenTrackId | null;
  label: string | null;
  tipoPersona: TipoPersonaFiscal | null;
  capability: CapabilityStatus | null;
}

export interface RegimenCalculationErrorPayload {
  code: "NOT_SUPPORTED";
  error: string;
  title: string;
  calculation: CalculationKind;
  reason: CapabilityFailureReason;
  regimen: RegimenCalculationDescriptor;
  /** Every active track considered. Present for multi-regime failures. */
  regimenes?: RegimenCalculationDescriptor[];
}

export class RegimenCalculationNotSupportedError extends Error {
  readonly code = "NOT_SUPPORTED" as const;
  readonly status = 422 as const;

  constructor(
    readonly calculation: CalculationKind,
    readonly reason: CapabilityFailureReason,
    readonly regimen: RegimenCalculationErrorPayload["regimen"],
    readonly regimenes?: RegimenCalculationDescriptor[],
  ) {
    const periodLabel = calculation === "MONTHLY" ? "mensual" : "anual";
    const regimenLabel = regimen.label
      ? `${regimen.code} · ${regimen.label}`
      : regimen.code ?? "sin régimen reconocido";
    const message = reason === "MULTI_REGIME_COMPOSITION_REQUIRED"
      ? `Este contribuyente tiene varios regímenes activos (${(regimenes ?? []).map((r) => r.code).filter(Boolean).join(", ")}). ContabilidadOS todavía no puede separar sus ingresos y deducciones por régimen, así que no generó ningún importe.`
      : reason === "NOT_APPLICABLE"
      ? `Este régimen no requiere el cálculo ${periodLabel} en ContabilidadOS. No se generó ningún importe.`
      : reason === "UNKNOWN_REGIME"
        ? `ContabilidadOS no reconoce el régimen fiscal (${regimenLabel}) y no generó ningún importe. Verifica la CSF con tu contador.`
        : reason === "UNKNOWN_TAXPAYER_TYPE"
          ? `No se pudo confirmar si el RFC corresponde a persona física o moral. No se generó ningún importe.`
          : reason === "INCOMPATIBLE_TAXPAYER_TYPE"
            ? `El régimen ${regimenLabel} no coincide con el tipo de contribuyente del RFC. No se generó ningún importe.`
            : `El cálculo ${periodLabel} para el régimen ${regimenLabel} requiere asistencia de tu contador. ContabilidadOS no generó ningún importe.`;
    super(message);
    this.name = "RegimenCalculationNotSupportedError";
  }

  toPayload(): RegimenCalculationErrorPayload {
    return {
      code: this.code,
      error: this.message,
      title: this.reason === "NOT_APPLICABLE"
        ? "Cálculo no aplicable"
        : this.reason === "MULTI_REGIME_COMPOSITION_REQUIRED"
          ? "Separación por régimen requerida"
        : "Cálculo asistido por tu contador",
      calculation: this.calculation,
      reason: this.reason,
      regimen: this.regimen,
      ...(this.regimenes ? { regimenes: this.regimenes } : {}),
    };
  }
}

export function isRegimenCalculationNotSupportedError(
  error: unknown,
): error is RegimenCalculationNotSupportedError {
  return error instanceof RegimenCalculationNotSupportedError;
}

const ENABLED_FOR_CALCULATION: ReadonlySet<CapabilityStatus> = new Set(["SUPPORTED", "PARTIAL"]);

/**
 * Canonical current regime set for calculation. The normalized scalar remains
 * first for legacy rows, but every CompanyRegimen code participates. A stale
 * scalar/relation mismatch therefore becomes a multi-regime boundary instead
 * of silently choosing either side.
 */
export function companyRegimenCodes(
  regimenFiscal: string | null | undefined,
  regimenes: ReadonlyArray<string | null | undefined> = [],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | null | undefined) => {
    for (const part of raw?.split(",") ?? []) {
      const code = part.trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      out.push(code);
    }
  };
  add(regimenFiscal);
  for (const code of regimenes) add(code);
  return out;
}

export interface CompanyCalculationContext {
  regimenFiscal: string | null | undefined;
  regimenes?: ReadonlyArray<string | null | undefined>;
  tipoPersona: TipoPersonaFiscal | null;
}

function descriptorForResolution(
  code: string | null,
  tipoPersona: TipoPersonaFiscal | null,
  calculation: CalculationKind,
): RegimenCalculationDescriptor {
  const resolution = resolveRegimenTrack(code, tipoPersona);
  if (!resolution.ok) {
    return {
      code: resolution.code,
      trackId: resolution.capability?.trackId ?? null,
      label: resolution.code ? REGIMEN_LABELS[resolution.code] ?? null : null,
      tipoPersona: resolution.tipoPersona,
      capability: null,
    };
  }
  const dimension = calculation === "MONTHLY" ? "monthly" : "annual";
  return {
    code: resolution.capability.code,
    trackId: resolution.capability.trackId,
    label: resolution.capability.label,
    tipoPersona,
    capability: resolution.capability.capabilities[dimension],
  };
}

function assertCompanyCalculationSupported(
  calculation: CalculationKind,
  context: CompanyCalculationContext,
): RegimenCapability {
  const codes = companyRegimenCodes(context.regimenFiscal, context.regimenes);
  if (codes.length > 1) {
    // A monthly-only regime cannot contaminate a different monthly engine when
    // its registry status is explicitly NOT_APPLICABLE. This covers common PF
    // combinations such as 612 + 605/611/614: salary, dividends, and interest
    // are annual baskets, while the 612 provisional still has one unambiguous
    // engine. Any second runnable, assisted, unknown, or incompatible track
    // still requires explicit allocations and remains fail-closed. Annual
    // calculation never takes this shortcut because those baskets must be
    // composed in the annual return.
    if (calculation === "MONTHLY") {
      let selected: RegimenCapability | null = null;
      let selectionIsSafe = true;
      for (const code of codes) {
        const resolution = resolveRegimenTrack(code, context.tipoPersona);
        if (!resolution.ok) {
          selectionIsSafe = false;
          break;
        }
        const status = resolution.capability.capabilities.monthly;
        if (ENABLED_FOR_CALCULATION.has(status)) {
          if (selected) {
            selectionIsSafe = false;
            break;
          }
          selected = resolution.capability;
        } else if (status !== "NOT_APPLICABLE") {
          selectionIsSafe = false;
          break;
        }
      }
      if (selectionIsSafe) {
        if (selected) return selected;
        return assertCalculationSupported(calculation, codes[0], context.tipoPersona);
      }
    }

    const regimenes = codes.map((code) => descriptorForResolution(code, context.tipoPersona, calculation));
    throw new RegimenCalculationNotSupportedError(
      calculation,
      "MULTI_REGIME_COMPOSITION_REQUIRED",
      regimenes[0],
      regimenes,
    );
  }
  return assertCalculationSupported(calculation, codes[0] ?? null, context.tipoPersona);
}

function assertCalculationSupported(
  calculation: CalculationKind,
  regimenFiscal: string | null | undefined,
  tipoPersona: TipoPersonaFiscal | null,
): RegimenCapability {
  const resolution = resolveRegimenTrack(regimenFiscal, tipoPersona);
  if (!resolution.ok) {
    throw new RegimenCalculationNotSupportedError(calculation, resolution.reason, {
      code: resolution.code,
      trackId: resolution.capability?.trackId ?? null,
      label: resolution.code ? REGIMEN_LABELS[resolution.code] ?? null : null,
      tipoPersona: resolution.tipoPersona,
      capability: null,
    });
  }

  const dimension = calculation === "MONTHLY" ? "monthly" : "annual";
  const status = resolution.capability.capabilities[dimension];
  if (!ENABLED_FOR_CALCULATION.has(status)) {
    const reason: CapabilityFailureReason = status === "NOT_APPLICABLE"
      ? "NOT_APPLICABLE"
      : status === "ASSISTED"
        ? "ASSISTED_ONLY"
        : "ENGINE_NOT_IMPLEMENTED";
    throw new RegimenCalculationNotSupportedError(calculation, reason, {
      code: resolution.capability.code,
      trackId: resolution.capability.trackId,
      label: resolution.capability.label,
      tipoPersona,
      capability: status,
    });
  }
  return resolution.capability;
}

export type MonthlyCalculationTrackId = "601" | "606" | "612" | "625" | "626-PF";
export type AnnualCalculationTrackId = "601" | "612";

export function assertMonthlyCalculationSupported(
  regimenFiscal: string | null | undefined,
  tipoPersona: TipoPersonaFiscal | null,
): RegimenCapability & { trackId: MonthlyCalculationTrackId } {
  return assertCalculationSupported("MONTHLY", regimenFiscal, tipoPersona) as RegimenCapability & {
    trackId: MonthlyCalculationTrackId;
  };
}

export function assertAnnualCalculationSupported(
  regimenFiscal: string | null | undefined,
  tipoPersona: TipoPersonaFiscal | null,
): RegimenCapability & { trackId: AnnualCalculationTrackId } {
  return assertCalculationSupported("ANNUAL", regimenFiscal, tipoPersona) as RegimenCapability & {
    trackId: AnnualCalculationTrackId;
  };
}

export function assertMonthlyCompanyCalculationSupported(
  context: CompanyCalculationContext,
): RegimenCapability & { trackId: MonthlyCalculationTrackId } {
  return assertCompanyCalculationSupported("MONTHLY", context) as RegimenCapability & {
    trackId: MonthlyCalculationTrackId;
  };
}

export function assertAnnualCompanyCalculationSupported(
  context: CompanyCalculationContext,
): RegimenCapability & { trackId: AnnualCalculationTrackId } {
  return assertCompanyCalculationSupported("ANNUAL", context) as RegimenCapability & {
    trackId: AnnualCalculationTrackId;
  };
}
