import { describe, it, expect } from "vitest";
import { calcularEnajenacion } from "./enajenacion";
import { factorActualizacionEnajenacion } from "./inpc";

// Sin esto, un activo vendido dejaba su saldo por deducir colgado para siempre:
// ni se deducía en el ejercicio de la venta ni aparecía en ningún lado.
const dia = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("factorActualizacionEnajenacion() — Art. 19", () => {
  it("es INPC del mes de venta entre INPC del mes de compra, de punta a punta", () => {
    const f = factorActualizacionEnajenacion({ adqYear: 2023, adqMonth: 1, ventaYear: 2025, ventaMonth: 6 });
    expect(f.completo).toBe(true);
    expect(f.numerador).toMatchObject({ year: 2025, month: 6 });
    expect(f.denominador).toMatchObject({ year: 2023, month: 1 });
    expect(f.factor).toBeGreaterThan(1);
  });

  it("sin INPC no inventa: factor 1 y marcado incompleto", () => {
    const f = factorActualizacionEnajenacion({ adqYear: 2023, adqMonth: 1, ventaYear: 2030, ventaMonth: 6 });
    expect(f).toMatchObject({ factor: 1, completo: false });
  });
});

describe("calcularEnajenacion()", () => {
  const base = {
    moiDeducible: 100000,
    depreciacionAcumulada: 60000,
    fechaAdquisicion: dia("2023-01-15"),
    fechaVenta: dia("2025-06-20"),
  };

  it("vendido por ARRIBA del saldo actualizado: ganancia acumulable", () => {
    const r = calcularEnajenacion({ ...base, precioVenta: 90000 });
    expect(r.saldoPendienteNominal).toBe(40000);
    expect(r.factorActualizacion).toBeGreaterThan(1);
    expect(r.saldoPendienteActualizado).toBe(Math.round(40000 * r.factorActualizacion * 100) / 100);
    expect(r.ganancia).toBe(Math.round((90000 - r.saldoPendienteActualizado) * 100) / 100);
    expect(r.perdida).toBe(0);
    expect(r.sinActualizar).toBe(false);
  });

  it("vendido por DEBAJO: pérdida deducible, nunca las dos cosas a la vez", () => {
    const r = calcularEnajenacion({ ...base, precioVenta: 10000 });
    expect(r.ganancia).toBe(0);
    expect(r.perdida).toBeGreaterThan(0);
    expect(r.perdida).toBe(Math.round((r.saldoPendienteActualizado - 10000) * 100) / 100);
  });

  // Desecharlo también es enajenarlo a cero: lo que falta por deducir se deduce.
  it("desechado (precio 0): la pérdida es todo el saldo actualizado", () => {
    const r = calcularEnajenacion({ ...base, precioVenta: 0 });
    expect(r.perdida).toBe(r.saldoPendienteActualizado);
    expect(r.ganancia).toBe(0);
  });

  it("totalmente depreciado: lo que se cobre es ganancia entera", () => {
    const r = calcularEnajenacion({ ...base, depreciacionAcumulada: 100000, precioVenta: 5000 });
    expect(r.saldoPendienteNominal).toBe(0);
    expect(r.saldoPendienteActualizado).toBe(0);
    expect(r.ganancia).toBe(5000);
  });

  it("la acumulada nunca deja el saldo en negativo", () => {
    const r = calcularEnajenacion({ ...base, depreciacionAcumulada: 150000, precioVenta: 0 });
    expect(r.saldoPendienteNominal).toBe(0);
    expect(r.perdida).toBe(0);
  });

  it("sin INPC queda NOMINAL y marcado, no a medias", () => {
    const r = calcularEnajenacion({ ...base, fechaVenta: dia("2030-06-20"), precioVenta: 50000 });
    expect(r.sinActualizar).toBe(true);
    expect(r.factorActualizacion).toBe(1);
    expect(r.saldoPendienteActualizado).toBe(40000);
    expect(r.ganancia).toBe(10000);
  });

  // El MOI que entra ya viene topado (Art. 36-II): un auto de $500k con tope de
  // $175k se enajena contra el tope, no contra lo que costó.
  it("el automóvil se enajena contra su MOI topado", () => {
    const r = calcularEnajenacion({ ...base, moiDeducible: 175000, depreciacionAcumulada: 175000, precioVenta: 200000 });
    expect(r.ganancia).toBe(200000);
  });
});
