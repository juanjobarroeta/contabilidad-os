import {
  VALID_REGIMENES,
  companyRegimenCodesForPeriod,
  type CompanyRegimenPeriodRow,
} from "./regimen-capabilities";
import { rangoPeriodoMensual } from "./periodo-operativo";

export const TOTAL_BASIS_POINTS = 10_000;

export interface InvoiceRegimenAllocationInput {
  regimenCode: unknown;
  basisPoints: unknown;
}

export interface ValidatedInvoiceRegimenAllocation {
  regimenCode: string;
  basisPoints: number;
}

export type InvoiceRegimenAllocationValidationCode =
  | "NO_EFFECTIVE_REGIMES"
  | "ALLOCATIONS_REQUIRED"
  | "UNKNOWN_REGIME"
  | "REGIME_OUTSIDE_PERIOD"
  | "DUPLICATE_REGIME"
  | "INVALID_BASIS_POINTS"
  | "INCOMPLETE_ALLOCATION";

export type InvoiceRegimenAllocationValidation =
  | {
      ok: true;
      allocations: ValidatedInvoiceRegimenAllocation[];
      totalBasisPoints: typeof TOTAL_BASIS_POINTS;
    }
  | {
      ok: false;
      code: InvoiceRegimenAllocationValidationCode;
      error: string;
    };

export interface InvoiceRegimenPeriodContext {
  periodo: string;
  from: Date;
  to: Date;
  regimenCodes: string[];
}

/**
 * Resolves the canonical UTC fiscal month used by invoice queries and returns
 * every CompanyRegimen row known to overlap it. The scalar is legacy fallback
 * only, matching the calculation boundary.
 */
export function invoiceRegimenPeriodContext(params: {
  fecha: Date;
  regimenFiscal: string | null | undefined;
  regimenes: ReadonlyArray<CompanyRegimenPeriodRow>;
}): InvoiceRegimenPeriodContext | null {
  const time = params.fecha.getTime();
  if (!Number.isFinite(time)) return null;

  const year = params.fecha.getUTCFullYear();
  const month = params.fecha.getUTCMonth() + 1;
  const { from, to } = rangoPeriodoMensual({ year, month });
  return {
    periodo: `${year}-${String(month).padStart(2, "0")}`,
    from,
    to,
    regimenCodes: companyRegimenCodesForPeriod({
      regimenFiscal: params.regimenFiscal,
      regimenes: params.regimenes,
      from,
      to,
    }),
  };
}

/**
 * Validates one complete replacement set. Zero-share rows are omitted; every
 * stored row must be positive and the exact integer sum must be 10,000.
 */
export function validateInvoiceRegimenAllocations(params: {
  allocations: ReadonlyArray<InvoiceRegimenAllocationInput>;
  effectiveRegimenCodes: ReadonlyArray<string>;
}): InvoiceRegimenAllocationValidation {
  const effectiveCodes = new Set(params.effectiveRegimenCodes.map((code) => code.trim()));
  if (effectiveCodes.size === 0) {
    return {
      ok: false,
      code: "NO_EFFECTIVE_REGIMES",
      error: "No hay un régimen fiscal confirmado para el mes de esta factura.",
    };
  }
  if (params.allocations.length === 0) {
    return {
      ok: false,
      code: "ALLOCATIONS_REQUIRED",
      error: "Agrega al menos una asignación por régimen.",
    };
  }

  const seen = new Set<string>();
  const allocations: ValidatedInvoiceRegimenAllocation[] = [];
  let total = 0;

  for (const raw of params.allocations) {
    const regimenCode = typeof raw.regimenCode === "string" ? raw.regimenCode.trim() : "";
    if (!VALID_REGIMENES.has(regimenCode)) {
      return {
        ok: false,
        code: "UNKNOWN_REGIME",
        error: `El régimen ${regimenCode || "sin clave"} no pertenece al catálogo reconocido.`,
      };
    }
    if (!effectiveCodes.has(regimenCode)) {
      return {
        ok: false,
        code: "REGIME_OUTSIDE_PERIOD",
        error: `El régimen ${regimenCode} no estaba vigente en el mes de esta factura.`,
      };
    }
    if (seen.has(regimenCode)) {
      return {
        ok: false,
        code: "DUPLICATE_REGIME",
        error: `El régimen ${regimenCode} aparece más de una vez.`,
      };
    }

    const basisPoints = raw.basisPoints;
    if (
      typeof basisPoints !== "number"
      || !Number.isInteger(basisPoints)
      || basisPoints < 1
      || basisPoints > TOTAL_BASIS_POINTS
    ) {
      return {
        ok: false,
        code: "INVALID_BASIS_POINTS",
        error: "Cada porcentaje debe expresarse en puntos base enteros entre 1 y 10,000.",
      };
    }

    seen.add(regimenCode);
    total += basisPoints;
    allocations.push({ regimenCode, basisPoints });
  }

  if (total !== TOTAL_BASIS_POINTS) {
    return {
      ok: false,
      code: "INCOMPLETE_ALLOCATION",
      error: `La asignación debe sumar exactamente 10,000 puntos base (100.00%); suma ${total}.`,
    };
  }

  return {
    ok: true,
    allocations,
    totalBasisPoints: TOTAL_BASIS_POINTS,
  };
}
