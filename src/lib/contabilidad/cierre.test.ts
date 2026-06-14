import { describe, it, expect } from "vitest";
import { construirCierre } from "./cierre";

const sum = (entries: { tipo: "CARGO" | "ABONO"; monto: number }[], t: "CARGO" | "ABONO") =>
  entries.filter((e) => e.tipo === t).reduce((s, e) => s + e.monto, 0);

describe("construirCierre — asiento de cierre del ejercicio", () => {
  it("utilidad: cancela ingresos/gastos y abona el resultado a capital", () => {
    const a = construirCierre(
      [
        { chartAccountId: "ing", tipo: "INGRESO", saldo: 100_000 },
        { chartAccountId: "gas", tipo: "GASTO", saldo: 60_000 },
        { chartAccountId: "cos", tipo: "COSTO", saldo: 10_000 },
      ],
      "resultado",
    );
    expect(a.totalIngresos).toBe(100_000);
    expect(a.totalGastos).toBe(70_000);
    expect(a.resultado).toBe(30_000); // utilidad
    // ingreso se cierra con CARGO; gasto/costo con ABONO; resultado (utilidad) ABONO.
    expect(a.entries).toContainEqual({ chartAccountId: "ing", tipo: "CARGO", monto: 100_000 });
    expect(a.entries).toContainEqual({ chartAccountId: "gas", tipo: "ABONO", monto: 60_000 });
    expect(a.entries).toContainEqual({ chartAccountId: "resultado", tipo: "ABONO", monto: 30_000 });
    // cuadra
    expect(sum(a.entries, "CARGO")).toBe(sum(a.entries, "ABONO"));
  });

  it("pérdida: el resultado se carga (CARGO) y el asiento cuadra", () => {
    const a = construirCierre(
      [
        { chartAccountId: "ing", tipo: "INGRESO", saldo: 40_000 },
        { chartAccountId: "gas", tipo: "GASTO", saldo: 100_000 },
      ],
      "resultado",
    );
    expect(a.resultado).toBe(-60_000); // pérdida
    expect(a.entries).toContainEqual({ chartAccountId: "resultado", tipo: "CARGO", monto: 60_000 });
    expect(sum(a.entries, "CARGO")).toBe(sum(a.entries, "ABONO"));
  });

  it("sin resultado neto (ingresos = gastos) no agrega partida de resultado", () => {
    const a = construirCierre(
      [
        { chartAccountId: "ing", tipo: "INGRESO", saldo: 50_000 },
        { chartAccountId: "gas", tipo: "GASTO", saldo: 50_000 },
      ],
      "resultado",
    );
    expect(a.resultado).toBe(0);
    expect(a.entries.some((e) => e.chartAccountId === "resultado")).toBe(false);
    expect(sum(a.entries, "CARGO")).toBe(sum(a.entries, "ABONO"));
  });
});
