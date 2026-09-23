import { describe, expect, it } from "vitest";
import { baseNeta, basePagada, sumaNeta } from "./base-neta";

describe("baseNeta", () => {
  it("resta el descuento del subtotal", () => {
    expect(baseNeta(1_000, 100)).toBe(900);
  });
  it("sin descuento es el subtotal (null, undefined o Decimal-like)", () => {
    expect(baseNeta(1_000, null)).toBe(1_000);
    expect(baseNeta("1000.50", undefined)).toBe(1_000.5);
  });
  it("nunca negativo", () => {
    expect(baseNeta(100, 150)).toBe(0);
  });
});

describe("sumaNeta", () => {
  it("resta la suma de descuentos de la suma de subtotales", () => {
    expect(sumaNeta({ subtotal: 1_371_046, descuento: 39_846 })).toBe(1_331_200);
  });
  it("agregado vacío es cero", () => {
    expect(sumaNeta({ subtotal: null, descuento: null })).toBe(0);
    expect(sumaNeta(undefined)).toBe(0);
  });
});

describe("basePagada", () => {
  // Factura: subtotal 1,000, descuento 100, IVA 16% sobre 900 = 144 → total 1,044.
  const factura = { subtotal: 1_000, descuento: 100, total: 1_044 };
  it("el pago total cobra la base neta completa", () => {
    expect(basePagada(1_044, factura)).toBeCloseTo(900, 6);
  });
  it("un pago parcial cobra su proporción de la base neta", () => {
    expect(basePagada(522, factura)).toBeCloseTo(450, 6);
  });
  it("sin descuento es la proporción del subtotal, como antes", () => {
    expect(basePagada(580, { subtotal: 1_000, total: 1_160 })).toBeCloseTo(500, 6);
  });
  it("total cero no divide", () => {
    expect(basePagada(10, { subtotal: 0, total: 0 })).toBe(0);
  });
});
