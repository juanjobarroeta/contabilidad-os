import { describe, expect, it } from "vitest";
import { saldosFinDeMes, type LoteSaldo } from "./saldos-banco";

const lote = (o: Partial<LoteSaldo>): LoteSaldo => ({
  periodo: "2026-06",
  bankAccountId: "cta-1",
  saldoFinal: 10_000,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  ...o,
});

describe("saldosFinDeMes", () => {
  it("usa el saldo que declaró el estado de cuenta", () => {
    const r = saldosFinDeMes([lote({ saldoFinal: 45_500 })], new Map());
    expect(r).toEqual([{ periodo: "2026-06", saldo: 45_500, fuente: "estado", cuentas: 1 }]);
  });

  it("SUMA las cuentas del mismo mes en vez de quedarse con una", () => {
    // El bug real: con varias cuentas se reportaba el saldo de la que
    // casualmente movió al último. Si ésa está sobregirada, la empresa
    // aparecía con saldo negativo teniendo dinero en la otra.
    const r = saldosFinDeMes(
      [
        lote({ bankAccountId: "cta-1", saldoFinal: -3_000 }),
        lote({ bankAccountId: "cta-2", saldoFinal: 120_000 }),
      ],
      new Map()
    );
    expect(r[0].saldo).toBe(117_000);
    expect(r[0].cuentas).toBe(2);
  });

  it("una reimportación de la misma cuenta PISA, no suma", () => {
    // Volver a subir el mismo estado de cuenta no duplica el dinero.
    const r = saldosFinDeMes(
      [
        lote({ saldoFinal: 10_000, createdAt: new Date("2026-07-01T00:00:00Z") }),
        lote({ saldoFinal: 12_500, createdAt: new Date("2026-07-05T00:00:00Z") }),
      ],
      new Map()
    );
    expect(r[0].saldo).toBe(12_500);
    expect(r[0].cuentas).toBe(1);
  });

  it("cae al saldo corrido sólo en los meses sin estado de cuenta", () => {
    const r = saldosFinDeMes(
      [lote({ periodo: "2026-06", saldoFinal: 50_000 })],
      new Map([
        ["2026-05", 33_000],
        ["2026-06", 999], // debe perder contra el estado de cuenta
      ])
    );
    expect(r).toEqual([
      { periodo: "2026-05", saldo: 33_000, fuente: "movimiento" },
      { periodo: "2026-06", saldo: 50_000, fuente: "estado", cuentas: 1 },
    ]);
  });

  it("ignora lotes sin periodo o sin saldo final", () => {
    const r = saldosFinDeMes(
      [lote({ periodo: null }), lote({ saldoFinal: null, bankAccountId: "cta-9" })],
      new Map()
    );
    expect(r).toEqual([]);
  });

  it("un saldo final de CERO es un dato, no un hueco", () => {
    // La cuenta quedó vacía: eso es información de crédito, no un faltante.
    const r = saldosFinDeMes([lote({ saldoFinal: 0 })], new Map([["2026-06", 8_000]]));
    expect(r[0].saldo).toBe(0);
    expect(r[0].fuente).toBe("estado");
  });

  it("un saldo negativo real se conserva (sobregiro de verdad)", () => {
    const r = saldosFinDeMes([lote({ saldoFinal: -1_200 })], new Map());
    expect(r[0].saldo).toBe(-1_200);
  });

  it("devuelve la serie ordenada por periodo", () => {
    const r = saldosFinDeMes(
      [
        lote({ periodo: "2026-06", bankAccountId: "c1" }),
        lote({ periodo: "2026-01", bankAccountId: "c1" }),
        lote({ periodo: "2025-12", bankAccountId: "c1" }),
      ],
      new Map()
    );
    expect(r.map((x) => x.periodo)).toEqual(["2025-12", "2026-01", "2026-06"]);
  });

  it("sin nada devuelve serie vacía", () => {
    expect(saldosFinDeMes([], new Map())).toEqual([]);
  });
});
