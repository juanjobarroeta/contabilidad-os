import { describe, it, expect } from "vitest";
import {
  PERIODO_TODO,
  etiquetaPeriodo,
  opcionesPeriodo,
  rangoPeriodo,
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

describe("opcionesPeriodo", () => {
  const conteos = [
    { periodo: "2026-07", total: 210 },
    { periodo: "2026-06", total: 180 },
    { periodo: "2025-12", total: 40 },
  ];

  it("ordena del más reciente al más antiguo, con los meses bajo su ejercicio", () => {
    expect(opcionesPeriodo(conteos).map((o) => o.valor)).toEqual([
      "todo",
      "2026",
      "2026-07",
      "2026-06",
      "2025",
      "2025-12",
    ]);
  });

  it("suma los totales por ejercicio y en el total general", () => {
    const ops = opcionesPeriodo(conteos);
    expect(ops.find((o) => o.valor === "todo")!.total).toBe(430);
    expect(ops.find((o) => o.valor === "2026")!.total).toBe(390);
    expect(ops.find((o) => o.valor === "2025")!.total).toBe(40);
  });

  it("sangra los meses (nivel 1) y deja ejercicios y «todo» al ras", () => {
    const ops = opcionesPeriodo(conteos);
    expect(ops.filter((o) => o.nivel === 1).map((o) => o.valor)).toEqual([
      "2026-07",
      "2026-06",
      "2025-12",
    ]);
  });

  it("nunca ofrece un mes vacío ni un periodo mal formado", () => {
    const ops = opcionesPeriodo([
      { periodo: "2026-07", total: 3 },
      { periodo: "2026-05", total: 0 },
      { periodo: "basura", total: 9 },
    ]);
    expect(ops.map((o) => o.valor)).toEqual(["todo", "2026", "2026-07"]);
    expect(ops[0].total).toBe(3);
  });

  it("sin comprobantes deja sólo «todo el historial» en cero", () => {
    expect(opcionesPeriodo([])).toEqual([
      { valor: "todo", etiqueta: "Todo el historial", total: 0, nivel: 0 },
    ]);
  });
});
