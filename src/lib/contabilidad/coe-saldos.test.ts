import { describe, it, expect } from "vitest";
import { naturalezaPorTipo, saldosCoe } from "./coe-saldos";

describe("naturalezaPorTipo", () => {
  it("deudora para ACTIVO/GASTO/COSTO, acreedora para el resto", () => {
    expect(naturalezaPorTipo("ACTIVO")).toBe("D");
    expect(naturalezaPorTipo("GASTO")).toBe("D");
    expect(naturalezaPorTipo("COSTO")).toBe("D");
    expect(naturalezaPorTipo("PASIVO")).toBe("A");
    expect(naturalezaPorTipo("CAPITAL")).toBe("A");
    expect(naturalezaPorTipo("INGRESO")).toBe("A");
  });
});

describe("saldosCoe — Anexo 24 (SaldoFin = SaldoIni ± movimiento)", () => {
  it("cuenta deudora: saldo inicial arrastrado + cargos − abonos del periodo", () => {
    // Banco: arrastra 1000 (1500 cargos − 500 abonos previos), este mes +300−100.
    const r = saldosCoe({ naturaleza: "D", priorCargos: 1500, priorAbonos: 500, cargos: 300, abonos: 100 });
    expect(r.saldoInicial).toBe(1000);
    expect(r.saldoFinal).toBe(1200); // 1000 + (300 − 100)
  });

  it("cuenta acreedora: invierte el signo (abonos − cargos)", () => {
    // Proveedores: arrastra 2000 (2000 abonos previos), este mes +800 abono −300 cargo.
    const r = saldosCoe({ naturaleza: "A", priorCargos: 0, priorAbonos: 2000, cargos: 300, abonos: 800 });
    expect(r.saldoInicial).toBe(2000);
    expect(r.saldoFinal).toBe(2500); // 2000 + (800 − 300)
  });

  it("continuidad: el saldoFinal de un mes es el saldoInicial del siguiente", () => {
    const mayo = saldosCoe({ naturaleza: "D", priorCargos: 0, priorAbonos: 0, cargos: 1000, abonos: 200 });
    expect(mayo.saldoFinal).toBe(800);
    // Junio arrastra mayo como inicial (priorCargos/abonos acumulan mayo).
    const junio = saldosCoe({ naturaleza: "D", priorCargos: 1000, priorAbonos: 200, cargos: 50, abonos: 0 });
    expect(junio.saldoInicial).toBe(mayo.saldoFinal);
    expect(junio.saldoFinal).toBe(850);
  });

  it("sin movimiento previo ni del periodo → 0", () => {
    const r = saldosCoe({ naturaleza: "A", priorCargos: 0, priorAbonos: 0, cargos: 0, abonos: 0 });
    expect(r).toEqual({ saldoInicial: 0, saldoFinal: 0 });
  });
});
