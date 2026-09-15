import { describe, expect, it } from "vitest";
import type {
  PpdRegimenReadinessApiResponse,
  PpdRegimenReadinessPendingItem,
} from "@/lib/fiscal/regimen-payment-allocation";
import {
  ppdPaymentReference,
  ppdReadinessSummaryParts,
  shouldShowPpdRegimenReadiness,
} from "./ppd-regimen-readiness";

function response(estado: PpdRegimenReadinessApiResponse["estado"]): PpdRegimenReadinessApiResponse {
  return {
    periodo: "2026-08",
    estado,
    evidenciaCompleta: estado !== "PENDIENTE",
    resumen: {
      totalRelaciones: 0,
      proyectables: 0,
      pendientes: 0,
      sinFacturaPadre: 0,
      sinImporte: 0,
      monedaExtranjera: 0,
      sinAsignacion: 0,
      transicionesRegimen: 0,
      otros: 0,
    },
    pagosPendientes: [],
    alcance: "RELACIONES_PPD_CON_FECHA_PAGO_EN_EL_MES",
    usadaEnCalculoAutomatico: false,
    limitaciones: [],
  };
}

function pendingItem(pago: PpdRegimenReadinessPendingItem["pago"]): PpdRegimenReadinessPendingItem {
  return {
    id: "link-1",
    parentUuid: "parent-uuid",
    fechaPago: "2026-08-15T12:00:00.000Z",
    pago,
    ok: false,
    code: "ASSIGNMENT_REQUIRED",
    error: "Falta asignación.",
    parent: null,
  };
}

describe("PPD regime readiness view model", () => {
  it("shows work only when the API reports pending blockers", () => {
    expect(shouldShowPpdRegimenReadiness(null)).toBe(false);
    expect(shouldShowPpdRegimenReadiness(response("SIN_PAGOS_PPD"))).toBe(false);
    expect(shouldShowPpdRegimenReadiness(response("COMPLETA"))).toBe(false);
    expect(shouldShowPpdRegimenReadiness(response("PENDIENTE"))).toBe(true);
  });

  it("prefers the REP series and folio as the payment reference", () => {
    expect(ppdPaymentReference(pendingItem({
      invoiceId: "rep-1",
      uuid: "12345678-1234-1234-1234-ABCDEF123456",
      serie: "P",
      folio: "42",
    }))).toBe("REP P-42");
  });

  it("falls back to the UUID suffix and then an explicit missing-folio label", () => {
    expect(ppdPaymentReference(pendingItem({
      invoiceId: "rep-1",
      uuid: "12345678-1234-1234-1234-ABCDEF123456",
      serie: null,
      folio: null,
    }))).toBe("REP EF123456");
    expect(ppdPaymentReference(pendingItem({
      invoiceId: "rep-2",
      uuid: null,
      serie: null,
      folio: null,
    }))).toBe("REP sin folio");
  });

  it("describes every non-zero blocker bucket without calling all parent issues missing", () => {
    expect(ppdReadinessSummaryParts({
      totalRelaciones: 12,
      proyectables: 2,
      pendientes: 10,
      sinFacturaPadre: 1,
      sinImporte: 2,
      monedaExtranjera: 3,
      sinAsignacion: 1,
      transicionesRegimen: 2,
      otros: 1,
    })).toEqual([
      "1 con problema en el CFDI padre",
      "1 sin asignación",
      "2 por cambio de régimen",
      "3 en moneda extranjera",
      "2 sin importe válido",
      "1 para revisión",
    ]);
  });

  it("omits zero-count blocker labels", () => {
    expect(ppdReadinessSummaryParts(response("COMPLETA").resumen)).toEqual([]);
  });
});
