import { VALID_REGIMENES } from "./regimen-capabilities";
import {
  validateInvoiceRegimenAllocations,
  type InvoiceRegimenAllocationInput,
  type InvoiceRegimenAllocationValidationCode,
} from "./regimen-allocation";

export type InvoiceRegimenReadinessState =
  | "SIN_ASIGNAR"
  | "COMPLETA"
  | "REQUIERE_REVISION";

export type RegimenAllocationPeriodState =
  | "SIN_REGIMEN_CONFIRMADO"
  | "REGIMEN_NO_RECONOCIDO"
  | "NO_REQUIERE_ASIGNACION"
  | "SIN_FACTURAS"
  | "PENDIENTE"
  | "COMPLETA";

export interface InvoiceRegimenReadinessInput {
  id: string;
  assignment: {
    allocations: ReadonlyArray<InvoiceRegimenAllocationInput>;
  } | null;
}

export interface InvoiceRegimenReadinessResult {
  id: string;
  estado: InvoiceRegimenReadinessState;
  observacion?: {
    code: InvoiceRegimenAllocationValidationCode;
    error: string;
  };
}

export interface RegimenAllocationReadinessResult {
  estado: RegimenAllocationPeriodState;
  requiereAsignacion: boolean;
  evidenciaCompleta: boolean;
  regimenCodes: string[];
  regimenCodesNoReconocidos: string[];
  resumen: {
    total: number;
    completas: number;
    sinAsignar: number;
    requierenRevision: number;
  };
  facturas: InvoiceRegimenReadinessResult[];
}

export interface RegimenAllocationReadinessApiResponse {
  periodo: string;
  estado: RegimenAllocationPeriodState;
  requiereAsignacion: boolean;
  evidenciaCompleta: boolean;
  regimenesDisponibles: Array<{ code: string; label: string | null }>;
  regimenesNoReconocidos: string[];
  resumen: RegimenAllocationReadinessResult["resumen"];
  facturasPendientes: Array<{
    id: string;
    tipo: "INGRESO" | "EGRESO";
    fecha: string;
    serie: string | null;
    folio: string | null;
    uuid: string | null;
    contraparte: string | null;
    rfc: string | null;
    total: number;
    estado: Exclude<InvoiceRegimenReadinessState, "COMPLETA">;
    observacion?: InvoiceRegimenReadinessResult["observacion"];
  }>;
  alcance: "CFDI_TIMBRADOS_EMITIDOS_O_RECIBIDOS_EN_EL_MES";
  usadaEnCalculoAutomatico: false;
  limitaciones: string[];
}

function normalizedCodes(codes: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of codes) {
    const code = raw?.trim() ?? "";
    if (!code || seen.has(code)) continue;
    seen.add(code);
    result.push(code);
  }
  return result.sort();
}

/**
 * Evaluates only emission-month evidence. A complete result is not permission
 * to calculate a mixed-regime return: payment-level attribution and the tax
 * engine remain separate gates.
 */
export function evaluateRegimenAllocationReadiness(params: {
  effectiveRegimenCodes: ReadonlyArray<string | null | undefined>;
  invoices: ReadonlyArray<InvoiceRegimenReadinessInput>;
}): RegimenAllocationReadinessResult {
  const regimenCodes = normalizedCodes(params.effectiveRegimenCodes);
  const regimenCodesNoReconocidos = regimenCodes.filter((code) => !VALID_REGIMENES.has(code));
  const emptySummary = {
    total: params.invoices.length,
    completas: 0,
    sinAsignar: 0,
    requierenRevision: 0,
  };

  if (regimenCodes.length === 0) {
    return {
      estado: "SIN_REGIMEN_CONFIRMADO",
      requiereAsignacion: false,
      evidenciaCompleta: false,
      regimenCodes,
      regimenCodesNoReconocidos,
      resumen: emptySummary,
      facturas: [],
    };
  }

  if (regimenCodesNoReconocidos.length > 0) {
    return {
      estado: "REGIMEN_NO_RECONOCIDO",
      requiereAsignacion: false,
      evidenciaCompleta: false,
      regimenCodes,
      regimenCodesNoReconocidos,
      resumen: emptySummary,
      facturas: [],
    };
  }

  if (regimenCodes.length === 1) {
    return {
      estado: "NO_REQUIERE_ASIGNACION",
      requiereAsignacion: false,
      evidenciaCompleta: true,
      regimenCodes,
      regimenCodesNoReconocidos,
      resumen: emptySummary,
      facturas: [],
    };
  }

  const facturas: InvoiceRegimenReadinessResult[] = params.invoices.map((invoice) => {
    if (!invoice.assignment) return { id: invoice.id, estado: "SIN_ASIGNAR" };

    const validation = validateInvoiceRegimenAllocations({
      effectiveRegimenCodes: regimenCodes,
      allocations: invoice.assignment.allocations,
    });
    if (validation.ok) return { id: invoice.id, estado: "COMPLETA" };
    return {
      id: invoice.id,
      estado: "REQUIERE_REVISION",
      observacion: { code: validation.code, error: validation.error },
    };
  });

  const resumen = {
    total: facturas.length,
    completas: facturas.filter((invoice) => invoice.estado === "COMPLETA").length,
    sinAsignar: facturas.filter((invoice) => invoice.estado === "SIN_ASIGNAR").length,
    requierenRevision: facturas.filter((invoice) => invoice.estado === "REQUIERE_REVISION").length,
  };
  const evidenciaCompleta = resumen.sinAsignar === 0 && resumen.requierenRevision === 0;

  return {
    estado: facturas.length === 0
      ? "SIN_FACTURAS"
      : evidenciaCompleta
        ? "COMPLETA"
        : "PENDIENTE",
    requiereAsignacion: true,
    evidenciaCompleta,
    regimenCodes,
    regimenCodesNoReconocidos,
    resumen,
    facturas,
  };
}
