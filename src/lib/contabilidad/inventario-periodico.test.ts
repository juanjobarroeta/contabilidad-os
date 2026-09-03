import { describe, expect, it } from "vitest";
import { costoPeriodico } from "./inventario-periodico";

describe("costoPeriodico — inicial + entradas − final", () => {
  it("caso normal: se consumió parte del inventario", () => {
    const r = costoPeriodico({ saldoInicial: 100_000, entradasNetas: 36_000, valorFinal: 90_000 });
    expect(r.costo).toBe(46_000);
    expect(r.advertencia).toBeNull();
  });

  it("mes de puro acopio: compras sin consumo → costo 0", () => {
    const r = costoPeriodico({ saldoInicial: 0, entradasNetas: 50_000, valorFinal: 50_000 });
    expect(r.costo).toBe(0);
    expect(r.advertencia).toBeNull();
  });

  it("conteo mayor que libros: ajuste invertido CON advertencia, nunca se esconde", () => {
    const r = costoPeriodico({ saldoInicial: 10_000, entradasNetas: 5_000, valorFinal: 18_000 });
    expect(r.costo).toBe(-3_000);
    expect(r.advertencia).toContain("supera al inventario según libros");
  });

  it("centavos: redondeo a 2 decimales", () => {
    const r = costoPeriodico({ saldoInicial: 10.105, entradasNetas: 0.101, valorFinal: 0 });
    expect(r.costo).toBe(10.21);
  });
});
