import { describe, it, expect } from "vitest";
import { calcularDescuentosRecurrentes, factorMensual } from "./descuentos-recurrentes";

const BASE = {
  descuentoFonacot: null,
  pensionAlimenticiaTipo: null,
  pensionAlimenticiaValor: null,
  periodicidadPago: "04", // quincenal
  diasPagados: 15,
  totalPercepciones: 9000,
  deduccionesLey: 1500,
};

describe("factorMensual", () => {
  it("periodicidades CFDI conocidas", () => {
    expect(factorMensual("02", 7)).toBeCloseTo(12 / 52); // semanal
    expect(factorMensual("03", 14)).toBeCloseTo(12 / 26); // catorcenal
    expect(factorMensual("04", 15)).toBe(0.5); // quincenal
    expect(factorMensual("05", 30)).toBe(1); // mensual
  });

  it("no mapeadas → aproximación por días/30.4", () => {
    expect(factorMensual("01", 10)).toBeCloseTo(10 / 30.4);
  });
});

describe("calcularDescuentosRecurrentes — FONACOT", () => {
  it("prorratea la retención MENSUAL de la cédula por periodicidad", () => {
    // Cédula: $1,200/mes; quincenal → $600 por periodo.
    const r = calcularDescuentosRecurrentes({ ...BASE, descuentoFonacot: 1200 });
    expect(r.fonacot).toBe(600);
  });

  it("sin crédito (null o 0) → 0", () => {
    expect(calcularDescuentosRecurrentes(BASE).fonacot).toBe(0);
    expect(calcularDescuentosRecurrentes({ ...BASE, descuentoFonacot: 0 }).fonacot).toBe(0);
  });
});

describe("calcularDescuentosRecurrentes — pensión alimenticia", () => {
  it("PCT_TOTAL: porcentaje de las percepciones del periodo", () => {
    const r = calcularDescuentosRecurrentes({
      ...BASE,
      pensionAlimenticiaTipo: "PCT_TOTAL",
      pensionAlimenticiaValor: 0.3,
    });
    expect(r.pensionAlimenticia).toBe(2700); // 30% de 9,000
  });

  it("PCT_NETO: porcentaje del neto tras deducciones de ley", () => {
    const r = calcularDescuentosRecurrentes({
      ...BASE,
      pensionAlimenticiaTipo: "PCT_NETO",
      pensionAlimenticiaValor: 0.3,
    });
    expect(r.pensionAlimenticia).toBe(2250); // 30% de (9,000 − 1,500)
  });

  it("PESOS: monto MENSUAL prorrateado por periodicidad", () => {
    const r = calcularDescuentosRecurrentes({
      ...BASE,
      pensionAlimenticiaTipo: "PESOS",
      pensionAlimenticiaValor: 2500,
    });
    expect(r.pensionAlimenticia).toBe(1250); // quincenal → mitad
  });

  it("tipo desconocido o valor nulo → 0", () => {
    expect(
      calcularDescuentosRecurrentes({ ...BASE, pensionAlimenticiaTipo: "OTRO", pensionAlimenticiaValor: 0.3 })
        .pensionAlimenticia
    ).toBe(0);
    expect(
      calcularDescuentosRecurrentes({ ...BASE, pensionAlimenticiaTipo: "PCT_TOTAL", pensionAlimenticiaValor: null })
        .pensionAlimenticia
    ).toBe(0);
  });

  it("PCT_NETO nunca sobre base negativa", () => {
    const r = calcularDescuentosRecurrentes({
      ...BASE,
      totalPercepciones: 1000,
      deduccionesLey: 1500,
      pensionAlimenticiaTipo: "PCT_NETO",
      pensionAlimenticiaValor: 0.5,
    });
    expect(r.pensionAlimenticia).toBe(0);
  });
});
