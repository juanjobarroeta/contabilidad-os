import { describe, expect, it } from "vitest";
import { evaluateRegimenAllocationReadiness } from "./regimen-allocation-readiness";

const invoice = (
  id: string,
  allocations: { regimenCode: string; basisPoints: number }[] | null,
) => ({
  id,
  assignment: allocations ? { allocations } : null,
});

describe("evaluateRegimenAllocationReadiness", () => {
  it("fails closed when the period has no confirmed regime", () => {
    expect(evaluateRegimenAllocationReadiness({
      effectiveRegimenCodes: [],
      invoices: [invoice("i-1", null)],
    })).toMatchObject({
      estado: "SIN_REGIMEN_CONFIRMADO",
      requiereAsignacion: false,
      evidenciaCompleta: false,
    });
  });

  it("fails closed when lifecycle evidence contains an unknown regime", () => {
    expect(evaluateRegimenAllocationReadiness({
      effectiveRegimenCodes: ["612", "999"],
      invoices: [],
    })).toMatchObject({
      estado: "REGIMEN_NO_RECONOCIDO",
      regimenCodesNoReconocidos: ["999"],
      evidenciaCompleta: false,
    });
  });

  it("does not require per-invoice evidence for a single-regime period", () => {
    expect(evaluateRegimenAllocationReadiness({
      effectiveRegimenCodes: [" 612 ", "612"],
      invoices: [invoice("i-1", null)],
    })).toMatchObject({
      estado: "NO_REQUIERE_ASIGNACION",
      requiereAsignacion: false,
      evidenciaCompleta: true,
      regimenCodes: ["612"],
    });
  });

  it("treats a multi-regime month without candidate CFDIs as complete evidence", () => {
    expect(evaluateRegimenAllocationReadiness({
      effectiveRegimenCodes: ["612", "606"],
      invoices: [],
    })).toMatchObject({
      estado: "SIN_FACTURAS",
      requiereAsignacion: true,
      evidenciaCompleta: true,
      resumen: { total: 0, completas: 0, sinAsignar: 0, requierenRevision: 0 },
    });
  });

  it("counts missing, complete, and stale invoice evidence for the whole month", () => {
    const result = evaluateRegimenAllocationReadiness({
      effectiveRegimenCodes: ["612", "606"],
      invoices: [
        invoice("missing", null),
        invoice("complete", [
          { regimenCode: "612", basisPoints: 7_500 },
          { regimenCode: "606", basisPoints: 2_500 },
        ]),
        invoice("stale", [{ regimenCode: "626", basisPoints: 10_000 }]),
      ],
    });

    expect(result).toMatchObject({
      estado: "PENDIENTE",
      requiereAsignacion: true,
      evidenciaCompleta: false,
      resumen: { total: 3, completas: 1, sinAsignar: 1, requierenRevision: 1 },
      facturas: [
        { id: "missing", estado: "SIN_ASIGNAR" },
        { id: "complete", estado: "COMPLETA" },
        {
          id: "stale",
          estado: "REQUIERE_REVISION",
          observacion: { code: "REGIME_OUTSIDE_PERIOD" },
        },
      ],
    });
  });

  it("marks the emission-month evidence complete only when every candidate is valid", () => {
    expect(evaluateRegimenAllocationReadiness({
      effectiveRegimenCodes: ["606", "612"],
      invoices: [
        invoice("i-1", [{ regimenCode: "612", basisPoints: 10_000 }]),
        invoice("i-2", [{ regimenCode: "606", basisPoints: 10_000 }]),
      ],
    })).toMatchObject({
      estado: "COMPLETA",
      evidenciaCompleta: true,
      resumen: { total: 2, completas: 2, sinAsignar: 0, requierenRevision: 0 },
    });
  });
});
