import { describe, it, expect } from "vitest";
import { calcularIsrRetenido } from "./isr";

// Salario mínimo general 2026: $315.04/día.
const MIN_DIARIO = 315.04;

describe("ISR retención — exención por salario mínimo (LISR Art. 96)", () => {
  it("salario mínimo MENSUAL 2026 → retención 0 y exento", () => {
    const r = calcularIsrRetenido({
      baseGravable: MIN_DIARIO * 30.4,
      periodicidadPago: "05",
      ejercicio: 2026,
      mes: 6,
    });
    expect(r.exentoSalarioMinimo).toBe(true);
    expect(r.isrRetenido).toBe(0);
  });

  it("salario mínimo QUINCENAL 2026 → retención 0 (base mensual ≤ tope)", () => {
    const r = calcularIsrRetenido({
      baseGravable: MIN_DIARIO * 15,
      periodicidadPago: "04",
      ejercicio: 2026,
      mes: 6,
    });
    expect(r.exentoSalarioMinimo).toBe(true);
    expect(r.isrRetenido).toBe(0);
  });

  it("enero (transitorio del subsidio) tampoco rompe la exención", () => {
    const r = calcularIsrRetenido({
      baseGravable: MIN_DIARIO * 30.4,
      periodicidadPago: "05",
      ejercicio: 2026,
      mes: 1,
    });
    expect(r.isrRetenido).toBe(0);
  });

  it("salario mínimo + percepción gravada que excede el tope → SÍ retiene", () => {
    const r = calcularIsrRetenido({
      baseGravable: 14000,
      periodicidadPago: "05",
      ejercicio: 2026,
      mes: 6,
    });
    expect(r.exentoSalarioMinimo).toBe(false);
    expect(r.isrRetenido).toBeGreaterThan(0);
  });

  it("Zona Libre de la Frontera Norte: salario mínimo fronterizo también exento", () => {
    const r = calcularIsrRetenido({
      baseGravable: 440.87 * 30.4, // salario mínimo ZLFN 2026
      periodicidadPago: "05",
      ejercicio: 2026,
      mes: 6,
      zonaFrontera: true,
    });
    expect(r.exentoSalarioMinimo).toBe(true);
    expect(r.isrRetenido).toBe(0);
  });
});
