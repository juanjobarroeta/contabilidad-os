import { describe, it, expect } from "vitest";
import {
  detectarSinCfdi,
  bancoLimpio,
  cfdiLimpio,
  parsePeriodo,
  periodoMesActual,
  limitesPeriodo,
  mensajeBancoSinCfdi,
  mensajeCfdiSinBanco,
  type MovimientoBanco,
  type CfdiCruce,
} from "./movimientos-sin-cfdi";

const mov = (
  id: string,
  monto: number,
  fecha: string,
  status = "UNMATCHED",
  descripcion = "MOVIMIENTO",
): MovimientoBanco => ({ id, monto, fecha: new Date(fecha), descripcion, status });

const cfdi = (
  id: string,
  tipo: string,
  total: number,
  fecha: string,
  metodoPago = "PUE",
  tieneMovimientoConciliado = false,
  uuid: string | null = null,
): CfdiCruce => ({ id, tipo, metodoPago, fecha: new Date(fecha), total, uuid, tieneMovimientoConciliado });

const PERIODO = "2026-06";

describe("detectarSinCfdi — caso limpio", () => {
  it("cada movimiento empata con su CFDI → no hay hallazgos", () => {
    const movimientos = [mov("t1", 1000, "2026-06-10"), mov("t2", -500, "2026-06-12")];
    const cfdis = [
      cfdi("i1", "INGRESO", 1000, "2026-06-10"),
      cfdi("e1", "EGRESO", 500, "2026-06-12"),
    ];
    const cruce = detectarSinCfdi({ periodo: PERIODO, movimientos, cfdis });
    expect(cruce.bancoSinCfdi).toHaveLength(0);
    expect(cruce.cfdiSinBanco).toHaveLength(0);
    expect(cruce.totalBancoSinCfdi).toBe(0);
    expect(cruce.totalCfdiSinBanco).toBe(0);
    expect(bancoLimpio(cruce)).toBe(true);
    expect(cfdiLimpio(cruce)).toBe(true);
  });

  it("sin movimientos ni CFDIs → todo limpio", () => {
    const cruce = detectarSinCfdi({ periodo: PERIODO, movimientos: [], cfdis: [] });
    expect(bancoLimpio(cruce)).toBe(true);
    expect(cfdiLimpio(cruce)).toBe(true);
  });
});

describe("detectarSinCfdi — banco sin CFDI", () => {
  it("movimiento UNMATCHED sin CFDI compatible se reporta con monto y conteo", () => {
    const movimientos = [mov("t1", 1500, "2026-06-10", "UNMATCHED", "DEPOSITO XYZ")];
    const cruce = detectarSinCfdi({ periodo: PERIODO, movimientos, cfdis: [] });
    expect(cruce.bancoSinCfdi).toHaveLength(1);
    expect(cruce.bancoSinCfdi[0].transaccionId).toBe("t1");
    expect(cruce.totalBancoSinCfdi).toBe(1500);
    expect(bancoLimpio(cruce)).toBe(false);
  });

  it("ignora movimientos MATCHED e IGNORED", () => {
    const movimientos = [
      mov("t1", 1500, "2026-06-10", "MATCHED"),
      mov("t2", 2000, "2026-06-11", "IGNORED"),
    ];
    const cruce = detectarSinCfdi({ periodo: PERIODO, movimientos, cfdis: [] });
    expect(cruce.bancoSinCfdi).toHaveLength(0);
  });

  it("el signo importa: un crédito NO empata con un CFDI EGRESO del mismo monto", () => {
    const movimientos = [mov("t1", 1000, "2026-06-10")]; // crédito → espera INGRESO
    const cfdis = [cfdi("e1", "EGRESO", 1000, "2026-06-10")];
    const cruce = detectarSinCfdi({ periodo: PERIODO, movimientos, cfdis });
    expect(cruce.bancoSinCfdi).toHaveLength(1); // sin CFDI INGRESO que lo respalde
  });

  it("suma totales en valor absoluto sobre varios movimientos sin CFDI", () => {
    const movimientos = [mov("t1", 1000, "2026-06-10"), mov("t2", -2500, "2026-06-11")];
    const cruce = detectarSinCfdi({ periodo: PERIODO, movimientos, cfdis: [] });
    expect(cruce.bancoSinCfdi).toHaveLength(2);
    expect(cruce.totalBancoSinCfdi).toBe(3500);
  });
});

describe("detectarSinCfdi — CFDI sin banco", () => {
  it("CFDI PUE sin movimiento conciliado ni movimiento compatible se reporta", () => {
    const cfdis = [cfdi("i1", "INGRESO", 4000, "2026-06-15", "PUE", false, "UUID-1")];
    const cruce = detectarSinCfdi({ periodo: PERIODO, movimientos: [], cfdis });
    expect(cruce.cfdiSinBanco).toHaveLength(1);
    expect(cruce.cfdiSinBanco[0].invoiceId).toBe("i1");
    expect(cruce.cfdiSinBanco[0].uuid).toBe("UUID-1");
    expect(cruce.totalCfdiSinBanco).toBe(4000);
    expect(cfdiLimpio(cruce)).toBe(false);
  });

  it("excluye PPD (su pago llega por complemento, no se exige aquí)", () => {
    const cfdis = [cfdi("i1", "INGRESO", 4000, "2026-06-15", "PPD")];
    const cruce = detectarSinCfdi({ periodo: PERIODO, movimientos: [], cfdis });
    expect(cruce.cfdiSinBanco).toHaveLength(0);
  });

  it("excluye CFDI PUE que ya tiene movimiento conciliado", () => {
    const cfdis = [cfdi("i1", "INGRESO", 4000, "2026-06-15", "PUE", true)];
    const cruce = detectarSinCfdi({ periodo: PERIODO, movimientos: [], cfdis });
    expect(cruce.cfdiSinBanco).toHaveLength(0);
  });

  it("excluye CFDI PUE si existe un movimiento UNMATCHED compatible que lo respalda", () => {
    const movimientos = [mov("t1", 4000, "2026-06-16")];
    const cfdis = [cfdi("i1", "INGRESO", 4000, "2026-06-15", "PUE")];
    const cruce = detectarSinCfdi({ periodo: PERIODO, movimientos, cfdis });
    // El movimiento respalda al CFDI → ni banco-sin-CFDI ni CFDI-sin-banco.
    expect(cruce.cfdiSinBanco).toHaveLength(0);
    expect(cruce.bancoSinCfdi).toHaveLength(0);
  });

  it("ignora tipos distintos de INGRESO/EGRESO (NOMINA, PAGO, TRASLADO)", () => {
    const cfdis = [
      cfdi("n1", "NOMINA", 5000, "2026-06-15", "PUE"),
      cfdi("p1", "PAGO", 5000, "2026-06-15", "PUE"),
    ];
    const cruce = detectarSinCfdi({ periodo: PERIODO, movimientos: [], cfdis });
    expect(cruce.cfdiSinBanco).toHaveLength(0);
  });
});

describe("detectarSinCfdi — tolerancia de monto", () => {
  it("diferencia dentro de la tolerancia empata (no se reporta)", () => {
    const movimientos = [mov("t1", 1000.5, "2026-06-10")];
    const cfdis = [cfdi("i1", "INGRESO", 1000, "2026-06-10", "PUE")];
    const cruce = detectarSinCfdi({ periodo: PERIODO, movimientos, cfdis, toleranciaPesos: 1 });
    expect(cruce.bancoSinCfdi).toHaveLength(0);
    expect(cruce.cfdiSinBanco).toHaveLength(0);
  });

  it("diferencia exactamente igual a la tolerancia SÍ empata (<=)", () => {
    const movimientos = [mov("t1", 1001, "2026-06-10")];
    const cfdis = [cfdi("i1", "INGRESO", 1000, "2026-06-10", "PUE")];
    const cruce = detectarSinCfdi({ periodo: PERIODO, movimientos, cfdis, toleranciaPesos: 1 });
    expect(cruce.bancoSinCfdi).toHaveLength(0);
    expect(cruce.cfdiSinBanco).toHaveLength(0);
  });

  it("diferencia que supera la tolerancia NO empata → ambos lados se reportan", () => {
    const movimientos = [mov("t1", 1002, "2026-06-10")];
    const cfdis = [cfdi("i1", "INGRESO", 1000, "2026-06-10", "PUE")];
    const cruce = detectarSinCfdi({ periodo: PERIODO, movimientos, cfdis, toleranciaPesos: 1 });
    expect(cruce.bancoSinCfdi).toHaveLength(1);
    expect(cruce.cfdiSinBanco).toHaveLength(1);
  });
});

describe("mensajes FORMALES", () => {
  it("mensaje banco-sin-CFDI incluye conteo y total en pesos", () => {
    const movimientos = [mov("t1", 1500, "2026-06-10", "UNMATCHED", "DEPOSITO")];
    const cruce = detectarSinCfdi({ periodo: PERIODO, movimientos, cfdis: [] });
    const msg = mensajeBancoSinCfdi(cruce);
    expect(msg).toContain("1 movimiento");
    expect(msg).toContain("2026-06");
    expect(msg).toContain("1,500");
  });

  it("mensaje CFDI-sin-banco incluye conteo y total en pesos", () => {
    const cfdis = [cfdi("i1", "INGRESO", 4000, "2026-06-15", "PUE")];
    const cruce = detectarSinCfdi({ periodo: PERIODO, movimientos: [], cfdis });
    const msg = mensajeCfdiSinBanco(cruce);
    expect(msg).toContain("1 CFDI");
    expect(msg).toContain("4,000");
  });
});

describe("helpers de periodo", () => {
  it("parsePeriodo válido", () => {
    expect(parsePeriodo("2026-06")).toEqual({ year: 2026, month: 6 });
  });
  it("parsePeriodo inválido lanza", () => {
    expect(() => parsePeriodo("2026/06")).toThrow();
    expect(() => parsePeriodo("2026-13")).toThrow();
  });
  it("periodoMesActual respeta la fecha de referencia", () => {
    expect(periodoMesActual(new Date("2026-06-30T12:00:00Z"))).toBe("2026-06");
    expect(periodoMesActual(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });
  it("limitesPeriodo devuelve [inicio, finExclusivo) del mes", () => {
    const { inicio, finExclusivo } = limitesPeriodo("2026-06");
    expect(inicio.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(finExclusivo.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });
});
