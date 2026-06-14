import { describe, it, expect } from "vitest";
import { mapTaxReturnAnual } from "./map";

// Campos del recurso TaxReturn confirmados en docs.syntage.com:
// intervalUnit ("Anual"|"Mensual"|"RIF"), fiscalYear/period, type,
// captureLine, presentedAt, payment.{paidAmount,dueAmount}.
describe("mapTaxReturnAnual", () => {
  it("maps an annual return (prefers paidAmount)", () => {
    expect(
      mapTaxReturnAnual({
        intervalUnit: "Anual",
        fiscalYear: 2024,
        type: "Normal",
        captureLine: "0123456789",
        presentedAt: "2025-03-28T10:00:00Z",
        payment: { paidAmount: 1500.5, dueAmount: 1500.5 },
      }),
    ).toEqual({
      ejercicio: 2024,
      isrPagar: 1500.5,
      lineaCaptura: "0123456789",
      fechaPresentacion: "2025-03-28T10:00:00Z",
      esComplementaria: false,
    });
  });

  it("ignores monthly and RIF returns (only annual maps here)", () => {
    expect(mapTaxReturnAnual({ intervalUnit: "Mensual", period: "Diciembre", fiscalYear: 2024 })).toBeNull();
    expect(mapTaxReturnAnual({ intervalUnit: "RIF", fiscalYear: 2024 })).toBeNull();
  });

  it("falls back to period for the year and to dueAmount for the amount", () => {
    const r = mapTaxReturnAnual({ intervalUnit: "Anual", period: "2023", payment: { dueAmount: 900 } });
    expect(r?.ejercicio).toBe(2023);
    expect(r?.isrPagar).toBe(900);
  });

  it("flags complementarias and tolerates a missing payment", () => {
    const r = mapTaxReturnAnual({ intervalUnit: "Anual", fiscalYear: 2022, type: "Complementaria" });
    expect(r?.esComplementaria).toBe(true);
    expect(r?.isrPagar).toBeNull();
  });

  it("returns null when the exercise can't be determined", () => {
    expect(mapTaxReturnAnual({ intervalUnit: "Anual", period: "Diciembre" })).toBeNull();
  });
});
