import { describe, it, expect } from "vitest";
import {
  DEDUCCION_CIEGA_ARRENDAMIENTO,
  calcularIsrArrendamientoMensual,
  esErogacionPredial,
} from "./isr-arrendamiento";

const EJERCICIO = 2026;

describe("calcularIsrArrendamientoMensual — deducción del Art. 115", () => {
  it("sin predial aplica sólo la ciega del 35%", () => {
    const r = calcularIsrArrendamientoMensual({ ejercicio: EJERCICIO, ingresosCobradosMes: 30000 })!;
    expect(r.deduccionCiega).toBe(10500); // 30,000 × 35%
    expect(r.predialPagado).toBe(0);
    expect(r.deduccionTotal).toBe(10500);
    expect(r.baseGravable).toBe(19500);
  });

  it("el predial pagado se deduce ADEMÁS de la ciega y baja la base", () => {
    const sin = calcularIsrArrendamientoMensual({ ejercicio: EJERCICIO, ingresosCobradosMes: 30000 })!;
    const con = calcularIsrArrendamientoMensual({
      ejercicio: EJERCICIO,
      ingresosCobradosMes: 30000,
      predialPagadoMes: 4200,
    })!;
    expect(con.predialPagado).toBe(4200);
    expect(con.deduccionTotal).toBe(14700); // 10,500 + 4,200
    expect(con.baseGravable).toBe(15300);
    // Ignorar el predial sobreestimaba la base y hacía pagar ISR de más.
    expect(con.baseGravable).toBeLessThan(sin.baseGravable);
    expect(con.isrCausado).toBeLessThan(sin.isrCausado);
  });

  it("un predial mayor que la base la deja en cero, nunca negativa", () => {
    const r = calcularIsrArrendamientoMensual({
      ejercicio: EJERCICIO,
      ingresosCobradosMes: 10000,
      predialPagadoMes: 50000,
    })!;
    expect(r.baseGravable).toBe(0);
    expect(r.isrCausado).toBe(0);
    expect(r.isrPagar).toBe(0);
  });

  it("un predial negativo o ausente se trata como cero", () => {
    const r = calcularIsrArrendamientoMensual({
      ejercicio: EJERCICIO,
      ingresosCobradosMes: 30000,
      predialPagadoMes: -900,
    })!;
    expect(r.predialPagado).toBe(0);
    expect(r.deduccionTotal).toBe(r.deduccionCiega);
  });

  it("la retención del 10% se acredita contra el causado y nunca deja negativo", () => {
    const r = calcularIsrArrendamientoMensual({
      ejercicio: EJERCICIO,
      ingresosCobradosMes: 30000,
      retencionesMes: 999999,
    })!;
    expect(r.isrPagar).toBe(0);
  });

  it("la tasa ciega es la del Art. 115", () => {
    expect(DEDUCCION_CIEGA_ARRENDAMIENTO).toBe(0.35);
  });
});

describe("esErogacionPredial", () => {
  it("reconoce el pago de predial en el concepto del banco", () => {
    expect(esErogacionPredial("PAGO IMPUESTO PREDIAL 2026")).toBe(true);
    expect(esErogacionPredial("predial bimestre 1")).toBe(true);
    expect(esErogacionPredial("TESORERIA MPAL PREDIALES")).toBe(true);
  });

  it("NO arrastra otras contribuciones municipales que no son deducibles con la ciega", () => {
    expect(esErogacionPredial("PAGO DE TENENCIA")).toBe(false);
    expect(esErogacionPredial("TESORERIA MUNICIPAL")).toBe(false);
    expect(esErogacionPredial("AGUA POTABLE")).toBe(false);
    expect(esErogacionPredial("MULTA DE TRANSITO")).toBe(false);
  });

  it("tolera vacío y nulo", () => {
    expect(esErogacionPredial("")).toBe(false);
    expect(esErogacionPredial(null)).toBe(false);
    expect(esErogacionPredial(undefined)).toBe(false);
  });
});
