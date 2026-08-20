import { describe, it, expect } from "vitest";
import { esVentaAlCosto, TOLERANCIA_AL_COSTO } from "./intercambio";

describe("esVentaAlCosto()", () => {
  it("precio igual a costo es intercambio", () => {
    expect(esVentaAlCosto(1_000_000, 1_000_000)).toBe(true);
  });

  it("aguanta el redondeo del DMS: nueve pesos sobre ciento cincuenta y nueve millones", () => {
    expect(esVentaAlCosto(158_954_544, 158_954_535)).toBe(true);
  });

  it("una venta con margen normal no lo es", () => {
    expect(esVentaAlCosto(1_000_000, 850_000)).toBe(false);
  });

  it("tampoco lo es una vendida bajo costo (ésa es otra historia)", () => {
    expect(esVentaAlCosto(1_000_000, 1_100_000)).toBe(false);
  });

  it("justo en el borde de la tolerancia", () => {
    const precio = 1_000_000;
    expect(esVentaAlCosto(precio, precio * (1 - TOLERANCIA_AL_COSTO / 2))).toBe(true);
    expect(esVentaAlCosto(precio, precio * (1 - TOLERANCIA_AL_COSTO * 2))).toBe(false);
  });

  it("sin precio o sin costo NO se clasifica: es dato faltante, no intercambio", () => {
    expect(esVentaAlCosto(0, 0)).toBe(false);
    expect(esVentaAlCosto(1_000_000, 0)).toBe(false);
    expect(esVentaAlCosto(0, 1_000_000)).toBe(false);
  });
});
