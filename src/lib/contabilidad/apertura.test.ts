import { describe, it, expect } from "vitest";
import { construirApertura } from "./apertura";

describe("construirApertura — saldos iniciales → partida doble", () => {
  it("deudoras → CARGO, acreedoras → ABONO; cuadra cuando balance = 0", () => {
    // Activos 100k (banco) = Pasivo 30k (proveedores) + Capital 70k.
    const a = construirApertura([
      { chartAccountId: "banco", naturaleza: "D", saldo: 100_000 },
      { chartAccountId: "prov", naturaleza: "A", saldo: 30_000 },
      { chartAccountId: "capital", naturaleza: "A", saldo: 70_000 },
    ]);
    expect(a.balanceado).toBe(true);
    expect(a.totalCargos).toBe(100_000);
    expect(a.totalAbonos).toBe(100_000);
    expect(a.entries).toContainEqual({ chartAccountId: "banco", tipo: "CARGO", monto: 100_000 });
    expect(a.entries).toContainEqual({ chartAccountId: "prov", tipo: "ABONO", monto: 30_000 });
  });

  it("detecta cuando NO cuadra (falta capital)", () => {
    const a = construirApertura([
      { chartAccountId: "banco", naturaleza: "D", saldo: 100_000 },
      { chartAccountId: "prov", naturaleza: "A", saldo: 30_000 },
    ]);
    expect(a.balanceado).toBe(false);
    expect(a.diferencia).toBe(70_000); // cargos 100k − abonos 30k
  });

  it("un saldo negativo invierte el lado", () => {
    // Banco (deudora) con saldo negativo → ABONO (sobregiro).
    const a = construirApertura([{ chartAccountId: "banco", naturaleza: "D", saldo: -500 }]);
    expect(a.entries[0]).toEqual({ chartAccountId: "banco", tipo: "ABONO", monto: 500 });
  });

  it("omite saldos ~0", () => {
    const a = construirApertura([
      { chartAccountId: "x", naturaleza: "D", saldo: 0 },
      { chartAccountId: "y", naturaleza: "A", saldo: 0.004 },
    ]);
    expect(a.entries).toHaveLength(0);
    expect(a.balanceado).toBe(true);
  });
});
