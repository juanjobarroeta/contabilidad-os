import { describe, it, expect } from "vitest";
import { construirApertura, toleranciaPorRedondeo } from "./apertura";

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

// ─── Tolerancia por redondeo ─────────────────────────────────────────────────
// Una balanza del SAT trae cada cuenta redondeada a dos decimales, así que el
// residuo crece con el NÚMERO DE CUENTAS y no con ningún error. MARGOM cierra a
// $0.13 sobre 438 hojas: el propio documento del SAT no cuadra al centavo.

describe("toleranciaPorRedondeo", () => {
  it("es medio centavo por cuenta — la cota exacta del redondeo a 2 decimales", () => {
    expect(toleranciaPorRedondeo(438)).toBe(2.19);
    expect(toleranciaPorRedondeo(1)).toBe(0.01);
    // Nunca por debajo de un centavo, aunque no haya cuentas.
    expect(toleranciaPorRedondeo(0)).toBe(0.01);
  });

  it("admite los $0.13 de MARGOM y sigue rechazando un descuadre real", () => {
    const tol = toleranciaPorRedondeo(438);
    expect(0.13).toBeLessThanOrEqual(tol);
    // El descuadre que traía por leer mal el signo lo rebasa por siete órdenes.
    expect(48_318_111.11).toBeGreaterThan(tol);
  });

  it("con la tolerancia por defecto, $0.13 NO cuadra", () => {
    const a = construirApertura([
      { chartAccountId: "activo", naturaleza: "D", saldo: 100_000.13 },
      { chartAccountId: "capital", naturaleza: "A", saldo: 100_000 },
    ]);
    // Un centavo es lo correcto para una apertura capturada a mano.
    expect(a.balanceado).toBe(false);
    expect(a.diferencia).toBe(0.13);
  });

  it("con la tolerancia por redondeo del documento, sí", () => {
    const a = construirApertura(
      [
        { chartAccountId: "activo", naturaleza: "D", saldo: 100_000.13 },
        { chartAccountId: "capital", naturaleza: "A", saldo: 100_000 },
      ],
      toleranciaPorRedondeo(438),
    );
    expect(a.balanceado).toBe(true);
    // Cuadra DENTRO DE TOLERANCIA, pero el residuo sigue ahí: postApertura lo
    // asienta como línea propia para que el libro no arranque torcido.
    expect(a.diferencia).toBe(0.13);
  });
});
