import { describe, expect, it } from "vitest";
import { consultarValorFiscal } from "./valores";

describe("consultarValorFiscal", () => {
  it("multa 82-I-a con cita, vigencia y montos", () => {
    const r = consultarValorFiscal({ tipo: "multa", articulo: "82", fraccion: "I", inciso: "a", fecha: "2026-09-04" });
    expect(r.cita).toBe("Art. 82 CFF");
    expect(r.verificado).toBe(true);
    expect((r.filas as { minimo: number; maximo: number }[])[0]).toMatchObject({ minimo: 2050, maximo: 25360 });
  });
  it("multa sin tabla vigente → error e instrucción de no inventar", () => {
    const r = consultarValorFiscal({ tipo: "multa", articulo: "82", fecha: "2015-01-01" });
    expect(String(r.error)).toMatch(/No hay tabla de multas/);
    expect(String(r.instruccion)).toMatch(/NO des un monto de memoria/);
  });
  it("tarifa mensual 2026 aplica la base", () => {
    const r = consultarValorFiscal({ tipo: "tarifa_isr", periodo: "mensual", base: 20000, fecha: "2026-06-01" });
    expect(r.cita).toBe("Art. 96 LISR");
    expect(r.ejercicio).toBe(2026);
    // 1,856.84 + (20,000 − 17,533.65) × 21.36 %
    expect(r.impuesto).toBe(2383.65);
  });
  it("UMA y salario mínimo salen del catálogo con vigencia", () => {
    const u = consultarValorFiscal({ tipo: "uma", fecha: "2026-03-01" });
    expect(u.diaria).toBe(117.31);
    const ene = consultarValorFiscal({ tipo: "uma", fecha: "2026-01-15" });
    expect(ene.diaria).toBe(113.14);
    const sm = consultarValorFiscal({ tipo: "salario_minimo", fecha: "2026-03-01" });
    expect(sm.generalDiario).toBe(315.04);
  });
  it("recargos 2026 con cálculo", () => {
    const r = consultarValorFiscal({ tipo: "recargos", base: 10000, meses: 3, fecha: "2026-09-04" });
    expect(r.tasaMensualMora).toBe(0.0207);
    expect(r.calculo).toEqual({ montoActualizado: 10000, meses: 3, recargos: 621 });
  });
  it("subsidio al empleo 2026", () => {
    const r = consultarValorFiscal({ tipo: "subsidio_empleo", fecha: "2026-06-01" });
    expect(r.pctUmaMensual).toBe(0.1502);
    expect(r.topeIngresoMensual).toBe(11492.66);
  });
});
