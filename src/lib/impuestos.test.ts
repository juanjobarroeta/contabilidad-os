import { describe, it, expect } from "vitest";
import { aplicarPerdidaFiscalPM } from "./impuestos";

// Amortización de pérdidas fiscales de ejercicios anteriores (PM Art. 14 LISR)
// en pagos provisionales: el remanente actualizado se resta de la utilidad
// fiscal estimada antes de aplicar la tasa del 30%.
describe("aplicarPerdidaFiscalPM", () => {
  it("(a) pérdida mayor que la utilidad → base 0", () => {
    const r = aplicarPerdidaFiscalPM({
      utilidadFiscal: 46_000,
      perdidaPendiente: 450_000,
      perdidaAnio: 2025,
      year: 2026,
    });
    expect(r.perdidaAplicada).toBe(46_000);
    expect(r.baseGravable).toBe(0);
    // base 0 ⇒ ISR del ejercicio = 0
    expect(r.baseGravable * 0.3).toBe(0);
  });

  it("(b) pérdida parcial → base reducida", () => {
    const r = aplicarPerdidaFiscalPM({
      utilidadFiscal: 100_000,
      perdidaPendiente: 30_000,
      perdidaAnio: 2025,
      year: 2026,
    });
    expect(r.perdidaAplicada).toBe(30_000);
    expect(r.baseGravable).toBe(70_000);
  });

  it("(c) sin pérdida pendiente → comportamiento sin cambios", () => {
    const sinPerdida = aplicarPerdidaFiscalPM({
      utilidadFiscal: 100_000,
      perdidaPendiente: null,
      perdidaAnio: null,
      year: 2026,
    });
    expect(sinPerdida.perdidaAplicada).toBe(0);
    expect(sinPerdida.baseGravable).toBe(100_000);

    const cero = aplicarPerdidaFiscalPM({
      utilidadFiscal: 100_000,
      perdidaPendiente: 0,
      perdidaAnio: 2025,
      year: 2026,
    });
    expect(cero.perdidaAplicada).toBe(0);
    expect(cero.baseGravable).toBe(100_000);
  });

  it("no aplica si el remanente es del ejercicio en curso o futuro", () => {
    const mismoAnio = aplicarPerdidaFiscalPM({
      utilidadFiscal: 100_000,
      perdidaPendiente: 50_000,
      perdidaAnio: 2026,
      year: 2026,
    });
    expect(mismoAnio.perdidaAplicada).toBe(0);
    expect(mismoAnio.baseGravable).toBe(100_000);
  });

  it("aplica cuando el ejercicio del remanente es null (sin año capturado)", () => {
    const r = aplicarPerdidaFiscalPM({
      utilidadFiscal: 100_000,
      perdidaPendiente: 40_000,
      perdidaAnio: null,
      year: 2026,
    });
    expect(r.perdidaAplicada).toBe(40_000);
    expect(r.baseGravable).toBe(60_000);
  });

  it("utilidad cero o negativa no genera base negativa", () => {
    const r = aplicarPerdidaFiscalPM({
      utilidadFiscal: 0,
      perdidaPendiente: 50_000,
      perdidaAnio: 2025,
      year: 2026,
    });
    expect(r.perdidaAplicada).toBe(0);
    expect(r.baseGravable).toBe(0);
  });
});
