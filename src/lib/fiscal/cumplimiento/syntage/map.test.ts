import { describe, it, expect } from "vitest";
import { mapTaxReturnAnual, camposAnualDesdeAcuse } from "./map";

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

describe("camposAnualDesdeAcuse", () => {
  const acuse = (over: Partial<Parameters<typeof camposAnualDesdeAcuse>[0]> = {}) => ({
    ingresosNominales: null,
    utilidadFiscal: null,
    perdidaFiscalRemanente: null,
    perdidasPendientes: null,
    coeficienteUtilidad: null,
    ...over,
  });

  it("deriva el coeficiente de la anual 2025 real (utilidad ÷ ingresos NOMINALES)", () => {
    // Cifras del acuse 2025 de Soluciones de Movilidad: utilidad 34,459 /
    // ingresos nominales 1,118,029 = 0.0308 (3.08%), NO 1,309,561 acumulables.
    const c = camposAnualDesdeAcuse(
      acuse({ ingresosNominales: 1_118_029, utilidadFiscal: 34_459, perdidaFiscalRemanente: 450_415 }),
    );
    expect(c.isrIngresos).toBe(1_118_029);
    expect(c.isrBaseGravable).toBe(34_459);
    expect(c.isrCoeficienteUtilidad).toBe(0.0308);
    expect(c.isrPerdidaPendiente).toBe(450_415);
  });

  it("deriva el coeficiente de la anual 2024 real (0.1640)", () => {
    const c = camposAnualDesdeAcuse(acuse({ ingresosNominales: 2_547_433, utilidadFiscal: 417_886 }));
    expect(c.isrCoeficienteUtilidad).toBe(0.164);
    expect(c.isrIngresos).toBe(2_547_433);
    expect(c.isrBaseGravable).toBe(417_886);
  });

  it("usa ingresos NOMINALES como denominador aunque haya acumulables distintos", () => {
    // Sólo se le pasan los nominales; el helper nunca ve acumulables → no puede
    // equivocar el denominador. Verifica que el cálculo use lo recibido.
    const c = camposAnualDesdeAcuse(acuse({ ingresosNominales: 1_000_000, utilidadFiscal: 50_000 }));
    expect(c.isrCoeficienteUtilidad).toBe(0.05);
  });

  it("en ejercicio con pérdida (utilidad ≤ 0) no escribe coeficiente, pero sí el remanente", () => {
    const c = camposAnualDesdeAcuse(
      acuse({ ingresosNominales: 800_000, utilidadFiscal: 0, perdidaFiscalRemanente: 120_000 }),
    );
    expect(c.isrIngresos).toBeNull();
    expect(c.isrBaseGravable).toBeNull();
    expect(c.isrCoeficienteUtilidad).toBeNull();
    expect(c.isrPerdidaPendiente).toBe(120_000);
  });

  it("usa perdidasPendientes como respaldo del remanente cuando éste falta", () => {
    const c = camposAnualDesdeAcuse(acuse({ perdidasPendientes: 75_000 }));
    expect(c.isrPerdidaPendiente).toBe(75_000);
  });

  it("sin cifras aprovechables devuelve todo null", () => {
    const c = camposAnualDesdeAcuse(acuse());
    expect(c).toEqual({
      isrIngresos: null,
      isrBaseGravable: null,
      isrCoeficienteUtilidad: null,
      isrPerdidaPendiente: null,
    });
  });
});
