import {
  REGIMEN_LABELS,
  VALID_REGIMENES,
} from "./regimen-capabilities";

export type CompanyRegimenSyncFailure =
  | "NO_REGIMES"
  | "UNKNOWN_REGIME"
  | "PRIMARY_NOT_IN_CSF"
  | "PRIMARY_REQUIRED";

export class CompanyRegimenSyncError extends Error {
  constructor(
    readonly code: CompanyRegimenSyncFailure,
    message: string,
  ) {
    super(message);
    this.name = "CompanyRegimenSyncError";
  }
}

export interface ExistingCompanyRegimen {
  code: string;
  label: string;
  since: Date | null;
  isPrimary: boolean;
  active: boolean;
}

export interface CsfCompanyRegimen {
  code: string;
  label?: string | null;
  /** SAT CSF date in DD/MM/YYYY format. */
  since?: string | null;
}

export interface CompanyRegimenSyncPlan {
  primaryCode: string;
  currentCodes: string[];
  activatedCodes: string[];
  deactivatedCodes: string[];
  upserts: Array<{
    code: string;
    label: string;
    since: Date | null;
    isPrimary: boolean;
  }>;
}

function normalizedCode(value: string | null | undefined): string | null {
  const code = value?.trim() ?? "";
  return code || null;
}

export function parseCsfRegimenDate(value: string | null | undefined): Date | null {
  const match = value?.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? parsed
    : null;
}

/**
 * Pure, fail-closed plan for replacing the active regime set from one CSF.
 * Historical rows are ended, never deleted. With several current regimes we
 * preserve a still-valid explicit primary; otherwise the caller must provide
 * one instead of silently choosing the first row in the PDF.
 */
export function planCompanyRegimenSync(params: {
  companyPrimary: string | null | undefined;
  parsedPrimary?: string | null;
  parsedRegimenes: ReadonlyArray<CsfCompanyRegimen>;
  existingRegimenes: ReadonlyArray<ExistingCompanyRegimen>;
}): CompanyRegimenSyncPlan {
  const parsedByCode = new Map<string, CsfCompanyRegimen>();
  for (const regimen of params.parsedRegimenes) {
    const code = normalizedCode(regimen.code);
    if (!code) continue;
    if (!VALID_REGIMENES.has(code)) {
      throw new CompanyRegimenSyncError(
        "UNKNOWN_REGIME",
        `La CSF contiene un régimen no reconocido (${code}). No se actualizó la empresa.`,
      );
    }
    if (!parsedByCode.has(code)) parsedByCode.set(code, regimen);
  }

  const currentCodes = [...parsedByCode.keys()];
  if (currentCodes.length === 0) {
    throw new CompanyRegimenSyncError(
      "NO_REGIMES",
      "No se pudo confirmar ningún régimen fiscal vigente en la CSF. No se actualizó la empresa.",
    );
  }

  const parsedPrimary = normalizedCode(params.parsedPrimary);
  if (parsedPrimary && !parsedByCode.has(parsedPrimary)) {
    throw new CompanyRegimenSyncError(
      "PRIMARY_NOT_IN_CSF",
      `El régimen principal (${parsedPrimary}) no aparece en la lista vigente de la CSF.`,
    );
  }

  const companyPrimary = normalizedCode(params.companyPrimary);
  const relationPrimary = params.existingRegimenes.find(
    (regimen) => regimen.isPrimary && parsedByCode.has(regimen.code),
  )?.code;
  const primaryCode = parsedPrimary
    ?? (companyPrimary && parsedByCode.has(companyPrimary) ? companyPrimary : null)
    ?? relationPrimary
    ?? (currentCodes.length === 1 ? currentCodes[0] : null);
  if (!primaryCode) {
    throw new CompanyRegimenSyncError(
      "PRIMARY_REQUIRED",
      "La CSF contiene varios regímenes y el principal anterior ya no está vigente. Elige el régimen principal antes de actualizar.",
    );
  }

  const existingByCode = new Map(params.existingRegimenes.map((regimen) => [regimen.code, regimen]));
  const currentSet = new Set(currentCodes);
  const activatedCodes = currentCodes.filter((code) => existingByCode.get(code)?.active !== true);
  const deactivatedCodes = params.existingRegimenes
    .filter((regimen) => regimen.active && !currentSet.has(regimen.code))
    .map((regimen) => regimen.code);
  const upserts = currentCodes.map((code) => {
    const parsed = parsedByCode.get(code)!;
    const existing = existingByCode.get(code);
    const existingLabel = existing?.label.trim();
    return {
      code,
      label: parsed.label?.trim()
        || (existingLabel && existingLabel !== code ? existingLabel : null)
        || REGIMEN_LABELS[code]
        || code,
      since: parseCsfRegimenDate(parsed.since) ?? existing?.since ?? null,
      isPrimary: code === primaryCode,
    };
  });

  return { primaryCode, currentCodes, activatedCodes, deactivatedCodes, upserts };
}
