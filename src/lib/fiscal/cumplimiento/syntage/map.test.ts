import { describe, it, expect } from "vitest";
import { mapTaxReturnAnual, camposAnualDesdeAcuse, mergeCamposAnual, type CamposAnualAcuse, anualesAutoritativas } from "./map";

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

describe("mergeCamposAnual", () => {
  const campos = (over: Partial<CamposAnualAcuse> = {}) => ({
    isrIngresos: null,
    isrBaseGravable: null,
    isrCoeficienteUtilidad: null,
    isrPerdidaPendiente: null,
    ...over,
  });

  it("lo extraído no-null corrige lo existente (caso real: utilidad guardada como ingresos)", () => {
    // Fila vieja de SMP 2025: un parseo anterior guardó la utilidad (34,459)
    // en isrIngresos y dejó la pérdida en null; el re-parseo del acuse trae
    // las cifras correctas y debe ganar.
    const merged = mergeCamposAnual(
      campos({ isrIngresos: 34_459, isrCoeficienteUtilidad: 0.0308 }),
      campos({
        isrIngresos: 1_118_029,
        isrBaseGravable: 34_459,
        isrCoeficienteUtilidad: 0.0308,
        isrPerdidaPendiente: 450_415,
      }),
    );
    expect(merged).toEqual({
      isrIngresos: 1_118_029,
      isrBaseGravable: 34_459,
      isrCoeficienteUtilidad: 0.0308,
      isrPerdidaPendiente: 450_415,
    });
  });

  it("un null extraído nunca borra un valor existente", () => {
    const merged = mergeCamposAnual(
      campos({ isrPerdidaPendiente: 450_415, isrCoeficienteUtilidad: 0.0308 }),
      campos({ isrIngresos: 1_118_029 }),
    );
    expect(merged).toEqual({
      isrIngresos: 1_118_029,
      isrBaseGravable: null,
      isrCoeficienteUtilidad: 0.0308,
      isrPerdidaPendiente: 450_415,
    });
  });

  it("devuelve null cuando nada cambia (ahorra el UPDATE)", () => {
    const iguales = campos({ isrIngresos: 100, isrPerdidaPendiente: 50 });
    expect(mergeCamposAnual(iguales, campos({ isrIngresos: 100, isrPerdidaPendiente: 50 }))).toBeNull();
    expect(mergeCamposAnual(iguales, campos())).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// anualesAutoritativas — la última presentada gana (complementarias)
// ─────────────────────────────────────────────────────────────────────────────

describe("anualesAutoritativas", () => {
  const ret = (
    fiscalYear: number,
    type: string,
    presentedAt: string | null,
    op = `${fiscalYear}-${type}`
  ) => ({
    intervalUnit: "Anual",
    fiscalYear,
    period: "Del Ejercicio",
    type,
    presentedAt,
    operationNumber: op,
    payment: {},
  });

  it("caso real MARGOM: 6 returns (normal+complementaria × 3 ejercicios) → 3 autoritativas", () => {
    // El orden del arreglo imita al API: complementarias primero, normales después.
    const returns = [
      ret(2025, "Complementaria", "2026-08-05"),
      ret(2024, "Complementaria", "2025-12-04"),
      ret(2023, "Complementaria", "2025-10-20"),
      ret(2024, "Normal", "2025-03-27"),
      ret(2025, "Normal", "2026-03-30"),
      ret(2023, "Normal", "2024-03-24"),
    ];
    const r = anualesAutoritativas(returns);
    expect(r.map((x) => x.anual.ejercicio)).toEqual([2025, 2024, 2023]);
    expect(r.every((x) => x.anual.esComplementaria)).toBe(true);
    expect(r[0].anual.fechaPresentacion).toBe("2026-08-05");
  });

  it("gana la última presentada aunque la normal venga primero en el arreglo", () => {
    const r = anualesAutoritativas([
      ret(2025, "Normal", "2026-03-30"),
      ret(2025, "Complementaria", "2026-08-05"),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].anual.esComplementaria).toBe(true);
  });

  it("una complementaria MÁS VIEJA que la normal no la sustituye", () => {
    // Complementaria de un ejercicio anterior al refrito: la normal re-presentada
    // después es la vigente.
    const r = anualesAutoritativas([
      ret(2024, "Complementaria", "2025-06-01"),
      ret(2024, "Normal", "2025-09-15"),
    ]);
    expect(r[0].anual.esComplementaria).toBe(false);
  });

  it("a fecha igual gana la complementaria; sin fecha pierde contra con fecha", () => {
    const empate = anualesAutoritativas([
      ret(2023, "Normal", "2024-03-24"),
      ret(2023, "Complementaria", "2024-03-24"),
    ]);
    expect(empate[0].anual.esComplementaria).toBe(true);

    const sinFecha = anualesAutoritativas([
      ret(2023, "Complementaria", null),
      ret(2023, "Normal", "2024-03-24"),
    ]);
    expect(sinFecha[0].anual.esComplementaria).toBe(false);
  });

  it("ignora returns que no son anuales", () => {
    const r = anualesAutoritativas([
      { intervalUnit: "Mensual", fiscalYear: 2025, period: "Julio", type: "Normal", payment: {} },
      ret(2025, "Normal", "2026-03-30"),
    ]);
    expect(r).toHaveLength(1);
  });
});
