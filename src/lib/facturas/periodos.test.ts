import { describe, it, expect } from "vitest";
import {
  MESES_CORTOS,
  PERIODO_TODO,
  agruparPorEjercicio,
  etiquetaPeriodo,
  rangoPeriodo,
  totalComprobantes,
} from "./periodos";

describe("rangoPeriodo", () => {
  it("un mes abarca del día 1 al último milisegundo (UTC, `to` inclusivo)", () => {
    const r = rangoPeriodo("2026-07")!;
    expect(r.from.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-07-31T23:59:59.999Z");
  });

  it("cierra bien los meses cortos y febrero bisiesto", () => {
    expect(rangoPeriodo("2026-02")!.to.toISOString()).toBe("2026-02-28T23:59:59.999Z");
    expect(rangoPeriodo("2028-02")!.to.toISOString()).toBe("2028-02-29T23:59:59.999Z");
    expect(rangoPeriodo("2026-04")!.to.toISOString()).toBe("2026-04-30T23:59:59.999Z");
  });

  it("diciembre no se desborda al año siguiente", () => {
    const r = rangoPeriodo("2026-12")!;
    expect(r.from.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-12-31T23:59:59.999Z");
  });

  it("un ejercicio abarca el año completo", () => {
    const r = rangoPeriodo("2026")!;
    expect(r.from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-12-31T23:59:59.999Z");
  });

  it("«todo» y los valores inválidos no producen ventana", () => {
    expect(rangoPeriodo(PERIODO_TODO)).toBeNull();
    expect(rangoPeriodo("2026-13")).toBeNull();
    expect(rangoPeriodo("2026-00")).toBeNull();
    expect(rangoPeriodo("julio")).toBeNull();
    expect(rangoPeriodo("")).toBeNull();
  });

  it("los límites del mes coinciden con los de postMonth (mismo mes contable)", () => {
    // posting.ts usa Date.UTC(year, month-1, 1) .. Date.UTC(year, month, 1).
    const r = rangoPeriodo("2026-07")!;
    expect(r.from.getTime()).toBe(Date.UTC(2026, 6, 1));
    expect(r.to.getTime() + 1).toBe(Date.UTC(2026, 7, 1));
  });
});

describe("etiquetaPeriodo", () => {
  it("nombra el mes en español y el ejercicio completo", () => {
    expect(etiquetaPeriodo("2026-07")).toBe("julio 2026");
    expect(etiquetaPeriodo("2025-01")).toBe("enero 2025");
    expect(etiquetaPeriodo("2026")).toBe("Todo 2026");
    expect(etiquetaPeriodo(PERIODO_TODO)).toBe("Todo el historial");
  });
});

describe("agruparPorEjercicio", () => {
  const conteos = [
    { periodo: "2026-07", total: 210 },
    { periodo: "2026-06", total: 180 },
    { periodo: "2025-12", total: 40 },
  ];

  it("ordena los ejercicios del más reciente al más antiguo", () => {
    expect(agruparPorEjercicio(conteos).map((e) => e.anio)).toEqual([2026, 2025]);
  });

  it("rellena SIEMPRE los 12 meses en orden natural, con cero donde no hubo nada", () => {
    const [dosMilVeintiseis] = agruparPorEjercicio(conteos);
    expect(dosMilVeintiseis.meses).toHaveLength(12);
    expect(dosMilVeintiseis.meses.map((m) => m.mes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(dosMilVeintiseis.meses[6]).toEqual({ periodo: "2026-07", mes: 7, total: 210 });
    expect(dosMilVeintiseis.meses[0]).toEqual({ periodo: "2026-01", mes: 1, total: 0 });
  });

  it("suma el total del ejercicio", () => {
    const grupos = agruparPorEjercicio(conteos);
    expect(grupos.find((e) => e.anio === 2026)!.total).toBe(390);
    expect(grupos.find((e) => e.anio === 2025)!.total).toBe(40);
  });

  it("ignora meses vacíos, periodos mal formados y meses fuera de rango", () => {
    const grupos = agruparPorEjercicio([
      { periodo: "2026-07", total: 3 },
      { periodo: "2026-05", total: 0 },
      { periodo: "2026-13", total: 5 },
      { periodo: "basura", total: 9 },
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].total).toBe(3);
  });

  it("un ejercicio sin comprobantes no aparece", () => {
    expect(agruparPorEjercicio([])).toEqual([]);
    expect(agruparPorEjercicio([{ periodo: "2026-03", total: 0 }])).toEqual([]);
  });
});

describe("totalComprobantes", () => {
  it("suma todo el historial e ignora la basura", () => {
    expect(
      totalComprobantes([
        { periodo: "2026-07", total: 210 },
        { periodo: "2025-12", total: 40 },
        { periodo: "basura", total: 9 },
      ])
    ).toBe(250);
    expect(totalComprobantes([])).toBe(0);
  });
});

describe("MESES_CORTOS", () => {
  it("son las abreviaturas de tres letras que van en la rejilla", () => {
    expect(MESES_CORTOS).toHaveLength(12);
    expect(MESES_CORTOS[0]).toBe("ene");
    expect(MESES_CORTOS[11]).toBe("dic");
    expect(MESES_CORTOS.every((m) => m.length === 3)).toBe(true);
  });
});
