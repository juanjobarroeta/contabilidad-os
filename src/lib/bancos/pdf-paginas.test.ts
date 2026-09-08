import { describe, expect, it } from "vitest";
import { rangosDeLotes } from "./pdf-paginas";

describe("rangosDeLotes", () => {
  // Los tres estados reales de agosto 2026 que destaparon el bug.
  it("parte las 17 páginas del estado de cheques en 5 lotes", () => {
    expect(rangosDeLotes(17)).toEqual([[1, 4], [5, 8], [9, 12], [13, 16], [17, 17]]);
  });

  it("parte las 11 de Banorte en 3", () => {
    expect(rangosDeLotes(11)).toEqual([[1, 4], [5, 8], [9, 11]]);
  });

  it("cubre todas las páginas sin huecos ni traslapes", () => {
    for (const n of [1, 2, 4, 5, 6, 11, 17, 40]) {
      const r = rangosDeLotes(n);
      expect(r[0][0]).toBe(1);
      expect(r[r.length - 1][1]).toBe(n);
      // Cada lote empieza justo donde terminó el anterior: un hueco perdería
      // movimientos y un traslape los duplicaría.
      for (let i = 1; i < r.length; i++) expect(r[i][0]).toBe(r[i - 1][1] + 1);
    }
  });

  it("un documento de una página es un solo lote", () => {
    expect(rangosDeLotes(1)).toEqual([[1, 1]]);
  });

  it("cero páginas no produce lotes", () => {
    expect(rangosDeLotes(0)).toEqual([]);
  });
});
