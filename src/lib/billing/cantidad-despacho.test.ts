import { describe, expect, it } from "vitest";
import { cantidadDespacho, DESPACHO_MINIMO_EMPRESAS } from "./cantidad-despacho";

describe("cantidadDespacho — regla max(10, empresas activas)", () => {
  it("el mínimo comercial es 10", () => {
    expect(DESPACHO_MINIMO_EMPRESAS).toBe(10);
  });

  it("por debajo del mínimo se cobra el mínimo (3 empresas → 10)", () => {
    expect(cantidadDespacho(3)).toBe(10);
    expect(cantidadDespacho(0)).toBe(10);
    expect(cantidadDespacho(9)).toBe(10);
  });

  it("en el mínimo exacto se cobra el mínimo (10 → 10)", () => {
    expect(cantidadDespacho(10)).toBe(10);
  });

  it("por encima del mínimo se cobra el conteo real (14 → 14)", () => {
    expect(cantidadDespacho(14)).toBe(14);
    expect(cantidadDespacho(11)).toBe(11);
    expect(cantidadDespacho(50)).toBe(50);
  });

  it("baja de una empresa desde 11 activas regresa al mínimo (11-1=10 → 10)", () => {
    const antes = cantidadDespacho(11);
    const despues = cantidadDespacho(11 - 1);
    expect(antes).toBe(11);
    expect(despues).toBe(10);
  });

  it("entradas degeneradas (negativas, NaN, no enteras) caen al piso sano", () => {
    expect(cantidadDespacho(-5)).toBe(10);
    expect(cantidadDespacho(Number.NaN)).toBe(10);
    expect(cantidadDespacho(Number.POSITIVE_INFINITY)).toBe(10);
    expect(cantidadDespacho(12.7)).toBe(12); // truncado, nunca cobra fracciones
  });
});
