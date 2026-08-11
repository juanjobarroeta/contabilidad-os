import { describe, expect, it } from "vitest";
import { montoPorPago, pagoMaximoPorBanda, pagoMensual, tablaAmortizacion } from "./amortizacion";

describe("amortización francesa", () => {
  it("pago conocido: $100,000 al 24% anual a 12 meses ≈ $9,455.96", () => {
    expect(pagoMensual(100_000, 0.24, 12)).toBeCloseTo(9455.96, 1);
  });

  it("montoPorPago es el inverso de pagoMensual", () => {
    const pago = pagoMensual(250_000, 0.36, 18);
    expect(montoPorPago(pago, 0.36, 18)).toBeCloseTo(250_000, 0);
  });

  it("tasa cero: pago = monto/plazo, sin intereses", () => {
    expect(pagoMensual(120_000, 0, 12)).toBe(10_000);
    const tabla = tablaAmortizacion(120_000, 0, 12);
    expect(tabla.every((f) => f.interes === 0)).toBe(true);
  });

  it("la tabla cierra el saldo exactamente en cero y suma el capital completo", () => {
    const tabla = tablaAmortizacion(100_000, 0.24, 12);
    expect(tabla).toHaveLength(12);
    expect(tabla[11].saldo).toBe(0);
    const capitalTotal = tabla.reduce((s, f) => s + f.capital, 0);
    expect(capitalTotal).toBeCloseTo(100_000, 0);
    // El interés decrece mes a mes (saldo decreciente).
    expect(tabla[0].interes).toBeGreaterThan(tabla[11].interes);
  });

  it("pago máximo por banda: la razón de servicio de deuda depende del riesgo", () => {
    expect(pagoMaximoPorBanda(100_000, "A")).toBe(40_000);
    expect(pagoMaximoPorBanda(100_000, "B")).toBe(30_000);
    expect(pagoMaximoPorBanda(100_000, "C")).toBe(20_000);
    expect(pagoMaximoPorBanda(100_000, "D")).toBe(0);
    expect(pagoMaximoPorBanda(-5, "A")).toBe(0);
  });
});
