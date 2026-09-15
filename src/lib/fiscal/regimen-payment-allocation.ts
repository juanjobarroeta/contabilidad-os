import { VALID_REGIMENES } from "./regimen-capabilities";
import {
  TOTAL_BASIS_POINTS,
  validateInvoiceRegimenAllocations,
  type InvoiceRegimenAllocationInput,
  type InvoiceRegimenAllocationValidationCode,
  type ValidatedInvoiceRegimenAllocation,
} from "./regimen-allocation";

export type RegimenPaymentProjectionCode =
  | InvoiceRegimenAllocationValidationCode
  | "INVALID_PAYMENT_BASE"
  | "INVALID_PARENT_TOTAL"
  | "INVALID_PARENT_SUBTOTAL"
  | "PAYMENT_EXCEEDS_PARENT_TOTAL"
  | "NO_PARENT_REGIME_EVIDENCE"
  | "UNKNOWN_PARENT_REGIME"
  | "NO_PAYMENT_REGIME_EVIDENCE"
  | "UNKNOWN_PAYMENT_REGIME"
  | "ASSIGNMENT_REQUIRED"
  | "REGIME_TRANSITION_REVIEW";

export type PpdRegimenReadinessFailureCode =
  | RegimenPaymentProjectionCode
  | "PARENT_INVOICE_NOT_FOUND"
  | "PARENT_UUID_AMBIGUOUS"
  | "PARENT_INVOICE_NOT_ELIGIBLE"
  | "FOREIGN_CURRENCY_REQUIRES_REVIEW"
  | "PAYMENT_AMOUNT_UNAVAILABLE";

export interface PpdRegimenReadinessPendingItem {
  id: string;
  parentUuid: string;
  fechaPago: string | null;
  pago: {
    invoiceId: string;
    uuid: string | null;
    serie: string | null;
    folio: string | null;
  };
  ok: false;
  code: PpdRegimenReadinessFailureCode;
  error: string;
  parent: null | {
    invoiceId: string;
    uuid: string | null;
    tipo: string;
    fecha: string;
    serie: string | null;
    folio: string | null;
    contraparte: string | null;
    rfc: string | null;
    moneda: string;
  };
}

export interface PpdRegimenReadinessApiResponse {
  periodo: string;
  estado: "SIN_PAGOS_PPD" | "COMPLETA" | "PENDIENTE";
  evidenciaCompleta: boolean;
  resumen: {
    totalRelaciones: number;
    proyectables: number;
    pendientes: number;
    sinFacturaPadre: number;
    sinImporte: number;
    monedaExtranjera: number;
    sinAsignacion: number;
    transicionesRegimen: number;
    otros: number;
  };
  pagosPendientes: PpdRegimenReadinessPendingItem[];
  alcance: "RELACIONES_PPD_CON_FECHA_PAGO_EN_EL_MES";
  usadaEnCalculoAutomatico: false;
  limitaciones: string[];
}

export type IntegerProrationResult =
  | { ok: true; amount: number }
  | { ok: false; code: RegimenPaymentProjectionCode; error: string };

export interface RegimenAmountAllocation {
  regimenCode: string;
  basisPoints: number;
  amountCentavos: number;
}

export type RegimenPaymentProjection =
  | {
      ok: true;
      source: "SINGLE_REGIME_IMPLICIT" | "REVIEWED_ASSIGNMENT";
      baseCentavos: number;
      allocations: RegimenAmountAllocation[];
      usadaEnCalculoAutomatico: false;
    }
  | {
      ok: false;
      code: RegimenPaymentProjectionCode;
      error: string;
      regimenCodes?: string[];
    };

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizedCodes(values: ReadonlyArray<string | null | undefined>): string[] {
  const codes = new Set<string>();
  for (const raw of values) {
    const code = raw?.trim() ?? "";
    if (code) codes.add(code);
  }
  return [...codes].sort();
}

/**
 * Computes the subtotal-equivalent paid amount from the database's integer
 * millionths using exact BigInt intermediate arithmetic. It rounds only the
 * final result to cents; half-cent results round up.
 */
export function proratePpdBaseCentavos(params: {
  impPagadoMicropesos: number;
  parentSubtotalMicropesos: number;
  parentTotalMicropesos: number;
}): IntegerProrationResult {
  if (!isPositiveSafeInteger(params.impPagadoMicropesos)) {
    return { ok: false, code: "INVALID_PAYMENT_BASE", error: "El pago debe ser un importe positivo en millonésimas de peso enteras." };
  }
  if (!Number.isSafeInteger(params.parentSubtotalMicropesos) || params.parentSubtotalMicropesos < 0) {
    return { ok: false, code: "INVALID_PARENT_SUBTOTAL", error: "El subtotal de la factura debe expresarse en millonésimas de peso enteras no negativas." };
  }
  if (!isPositiveSafeInteger(params.parentTotalMicropesos)) {
    return { ok: false, code: "INVALID_PARENT_TOTAL", error: "El total de la factura debe ser positivo y estar expresado en millonésimas de peso enteras." };
  }
  if (params.impPagadoMicropesos > params.parentTotalMicropesos) {
    return { ok: false, code: "PAYMENT_EXCEEDS_PARENT_TOTAL", error: "El pago no puede exceder el total de la factura padre." };
  }

  // Values enter as millionths because the database columns are Decimal(18,6).
  // Converting the ratio to cents adds a factor of 10,000 to the denominator
  // (1 peso = 1,000,000 micros = 100 cents). Round only after proration.
  const numerator = BigInt(params.impPagadoMicropesos) * BigInt(params.parentSubtotalMicropesos);
  const denominator = BigInt(params.parentTotalMicropesos) * BigInt(10_000);
  const two = BigInt(2);
  const rounded = (numerator * two + denominator) / (denominator * two);
  const amount = Number(rounded);
  if (!Number.isSafeInteger(amount)) {
    return { ok: false, code: "INVALID_PAYMENT_BASE", error: "La base prorrateada excede el rango monetario seguro." };
  }
  return { ok: true, amount };
}

/**
 * Splits an integer-cent amount with the largest-remainder method. Fractions
 * tie-break by regime code, so order of input never changes who receives the
 * residual cent. The output always sums exactly to amountCentavos.
 */
export function allocateCentavosByBasisPoints(params: {
  amountCentavos: number;
  allocations: ReadonlyArray<ValidatedInvoiceRegimenAllocation>;
}): RegimenAmountAllocation[] {
  if (!Number.isSafeInteger(params.amountCentavos) || params.amountCentavos < 0) {
    throw new RangeError("amountCentavos must be a non-negative safe integer");
  }
  const validation = validateInvoiceRegimenAllocations({
    effectiveRegimenCodes: params.allocations.map((allocation) => allocation.regimenCode),
    allocations: params.allocations,
  });
  if (!validation.ok) throw new RangeError(validation.error);

  const amount = BigInt(params.amountCentavos);
  const denominator = BigInt(TOTAL_BASIS_POINTS);
  const rows = validation.allocations.map((allocation) => {
    const numerator = amount * BigInt(allocation.basisPoints);
    return {
      regimenCode: allocation.regimenCode,
      basisPoints: allocation.basisPoints,
      amountCentavos: Number(numerator / denominator),
      remainder: numerator % denominator,
    };
  });

  const assigned = rows.reduce((sum, row) => sum + row.amountCentavos, 0);
  let residual = params.amountCentavos - assigned;
  const residualOrder = [...rows].sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
    return left.regimenCode.localeCompare(right.regimenCode);
  });
  for (let index = 0; residual > 0; index += 1, residual -= 1) {
    residualOrder[index].amountCentavos += 1;
  }

  return rows
    .map(({ remainder: _remainder, ...row }) => row)
    .sort((left, right) => left.regimenCode.localeCompare(right.regimenCode));
}

/**
 * Projects reviewed invoice evidence onto one PPD payment base. A regime code
 * must still be present in the payment month; a transition is deliberately a
 * review state because this contract does not decide Mexican transition law.
 */
export function projectPpdRegimenAllocation(params: {
  baseCentavos: number;
  parentEffectiveRegimenCodes: ReadonlyArray<string | null | undefined>;
  paymentEffectiveRegimenCodes: ReadonlyArray<string | null | undefined>;
  assignment: {
    allocations: ReadonlyArray<InvoiceRegimenAllocationInput>;
  } | null;
}): RegimenPaymentProjection {
  if (!isPositiveSafeInteger(params.baseCentavos)) {
    return { ok: false, code: "INVALID_PAYMENT_BASE", error: "La base pagada debe ser un importe positivo en centavos enteros." };
  }

  const parentCodes = normalizedCodes(params.parentEffectiveRegimenCodes);
  if (parentCodes.length === 0) {
    return { ok: false, code: "NO_PARENT_REGIME_EVIDENCE", error: "No hay régimen confirmado para el mes de emisión de la factura." };
  }
  const unknownParentCodes = parentCodes.filter((code) => !VALID_REGIMENES.has(code));
  if (unknownParentCodes.length > 0) {
    return {
      ok: false,
      code: "UNKNOWN_PARENT_REGIME",
      error: `La factura tiene regímenes no reconocidos: ${unknownParentCodes.join(", ")}.`,
      regimenCodes: unknownParentCodes,
    };
  }

  const paymentCodes = normalizedCodes(params.paymentEffectiveRegimenCodes);
  if (paymentCodes.length === 0) {
    return { ok: false, code: "NO_PAYMENT_REGIME_EVIDENCE", error: "No hay régimen confirmado para el mes del pago." };
  }
  const unknownPaymentCodes = paymentCodes.filter((code) => !VALID_REGIMENES.has(code));
  if (unknownPaymentCodes.length > 0) {
    return {
      ok: false,
      code: "UNKNOWN_PAYMENT_REGIME",
      error: `El mes del pago tiene regímenes no reconocidos: ${unknownPaymentCodes.join(", ")}.`,
      regimenCodes: unknownPaymentCodes,
    };
  }

  let source: "SINGLE_REGIME_IMPLICIT" | "REVIEWED_ASSIGNMENT";
  let allocations: ValidatedInvoiceRegimenAllocation[];
  if (!params.assignment) {
    if (parentCodes.length > 1) {
      return {
        ok: false,
        code: "ASSIGNMENT_REQUIRED",
        error: "La factura pertenece a un mes con varios regímenes y todavía no tiene una asignación revisada.",
      };
    }
    source = "SINGLE_REGIME_IMPLICIT";
    allocations = [{ regimenCode: parentCodes[0], basisPoints: TOTAL_BASIS_POINTS }];
  } else {
    const validation = validateInvoiceRegimenAllocations({
      effectiveRegimenCodes: parentCodes,
      allocations: params.assignment.allocations,
    });
    if (!validation.ok) return { ok: false, code: validation.code, error: validation.error };
    source = "REVIEWED_ASSIGNMENT";
    allocations = validation.allocations;
  }

  const paymentCodeSet = new Set(paymentCodes);
  const codesOutsidePaymentPeriod = allocations
    .map((allocation) => allocation.regimenCode)
    .filter((code) => !paymentCodeSet.has(code));
  if (codesOutsidePaymentPeriod.length > 0) {
    return {
      ok: false,
      code: "REGIME_TRANSITION_REVIEW",
      error: `La asignación usa regímenes que ya no aparecen en el mes del pago: ${codesOutsidePaymentPeriod.join(", ")}. Requiere revisión del contador.`,
      regimenCodes: codesOutsidePaymentPeriod,
    };
  }

  return {
    ok: true,
    source,
    baseCentavos: params.baseCentavos,
    allocations: allocateCentavosByBasisPoints({
      amountCentavos: params.baseCentavos,
      allocations,
    }),
    usadaEnCalculoAutomatico: false,
  };
}
