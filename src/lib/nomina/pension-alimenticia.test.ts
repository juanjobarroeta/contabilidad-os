// ─── Pruebas: pensión alimenticia (Arts. 110 fracc. V y 112 LFT) ─────────────
// Deducción post-impuestos por resolución judicial. Verifica los tres tipos de
// captura (PCT_NETO, PCT_SBC, MONTO_FIJO), el tope al neto disponible y los
// casos sin pensión.

import { describe, it, expect } from "vitest";
import { calcularPensionAlimenticia } from "./pension-alimenticia";

const BASE = {
  netoAntesPension: 8000,
  salarioBaseCotizacion: 600,
  diasPagados: 15,
};

describe("calcularPensionAlimenticia", () => {
  it("PCT_NETO: porcentaje del neto tras deducciones de ley", () => {
    const monto = calcularPensionAlimenticia({ ...BASE, tipo: "PCT_NETO", valor: 0.2 });
    expect(monto).toBe(1600); // 8,000 × 20%
  });

  it("PCT_SBC: porcentaje del SBC diario por los días del periodo", () => {
    const monto = calcularPensionAlimenticia({ ...BASE, tipo: "PCT_SBC", valor: 0.15 });
    expect(monto).toBe(1350); // 600 × 15 × 15%
  });

  it("MONTO_FIJO: monto fijo por periodo de pago", () => {
    const monto = calcularPensionAlimenticia({ ...BASE, tipo: "MONTO_FIJO", valor: 2500 });
    expect(monto).toBe(2500);
  });

  it("tope: la pensión nunca excede el neto disponible del periodo", () => {
    const monto = calcularPensionAlimenticia({ ...BASE, tipo: "MONTO_FIJO", valor: 10000 });
    expect(monto).toBe(8000); // topada al neto — el recibo no queda en negativo
  });

  it("neto no positivo (p.ej. periodo con puras faltas): pensión 0", () => {
    expect(
      calcularPensionAlimenticia({ ...BASE, netoAntesPension: 0, tipo: "PCT_NETO", valor: 0.2 })
    ).toBe(0);
    expect(
      calcularPensionAlimenticia({ ...BASE, netoAntesPension: -100, tipo: "MONTO_FIJO", valor: 500 })
    ).toBe(0);
  });

  it("sin resolución capturada (tipo/valor nulos o inválidos): 0", () => {
    expect(calcularPensionAlimenticia({ ...BASE, tipo: null, valor: 0.2 })).toBe(0);
    expect(calcularPensionAlimenticia({ ...BASE, tipo: "PCT_NETO", valor: null })).toBe(0);
    expect(calcularPensionAlimenticia({ ...BASE, tipo: "PCT_NETO", valor: 0 })).toBe(0);
    expect(calcularPensionAlimenticia({ ...BASE, tipo: "OTRO_TIPO", valor: 0.2 })).toBe(0);
  });

  it("redondea a centavos", () => {
    // 8,000.33 × 20% = 1,600.066 → 1,600.07
    const monto = calcularPensionAlimenticia({
      ...BASE,
      netoAntesPension: 8000.33,
      tipo: "PCT_NETO",
      valor: 0.2,
    });
    expect(monto).toBe(1600.07);
  });
});
