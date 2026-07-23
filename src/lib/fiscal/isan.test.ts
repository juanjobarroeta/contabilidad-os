import { describe, it, expect } from "vitest";
import { calcularIsan, getTarifaIsan, type IsanTarifa } from "./isan";

// Tarifa sintética con números redondos: los tests validan la MECÁNICA del
// Art. 3-I + Art. 8-II sin depender de los montos anuales (que se cotejan
// contra DOF por separado y viven marcados `verificada: false` hasta entonces).
const TARIFA_TEST: IsanTarifa = {
  ejercicio: 2099,
  brackets: [
    { limiteInferior: 0.01, limiteSuperior: 100_000, cuotaFija: 0, tasaExcedente: 0.02 },
    { limiteInferior: 100_000.01, limiteSuperior: 200_000, cuotaFija: 2_000, tasaExcedente: 0.05 },
    { limiteInferior: 200_000.01, limiteSuperior: null, cuotaFija: 7_000, tasaExcedente: 0.17 },
  ],
  exencionTotalHasta: 80_000,
  exencionParcialHasta: 120_000,
  verificada: true,
  fuente: "tarifa sintética de prueba",
};

describe("calcularIsan() — mecánica de la tarifa (Art. 3-I)", () => {
  it("aplica cuota fija + tasa sobre el excedente del límite inferior", () => {
    // 150,000 → bracket 2: 2,000 + 5% de (150,000 − 100,000.01)
    const r = calcularIsan(150_000, 2099, TARIFA_TEST);
    expect(r.impuestoTarifa).toBeCloseTo(2_000 + (150_000 - 100_000.01) * 0.05, 2);
    expect(r.exencion).toBeNull();
    expect(r.isan).toBe(r.impuestoTarifa);
  });

  it("usa el último bracket para precios en adelante", () => {
    const r = calcularIsan(1_000_000, 2099, TARIFA_TEST);
    expect(r.impuestoTarifa).toBeCloseTo(7_000 + (1_000_000 - 200_000.01) * 0.17, 2);
  });

  it("precio en el primer bracket paga sólo la tasa (cuota fija 0)", () => {
    // 90,000 > exencionTotalHasta (80,000) pero ≤ exencionParcialHasta →
    // impuesto de tarifa con 50% de exención.
    const r = calcularIsan(90_000, 2099, TARIFA_TEST);
    expect(r.impuestoTarifa).toBeCloseTo((90_000 - 0.01) * 0.02, 2);
  });
});

describe("calcularIsan() — exenciones (Art. 8-II)", () => {
  it("exención total: precio ≤ umbral inferior no paga", () => {
    const r = calcularIsan(80_000, 2099, TARIFA_TEST);
    expect(r.exencion).toBe("TOTAL");
    expect(r.isan).toBe(0);
    expect(r.impuestoTarifa).toBeGreaterThan(0); // el impuesto de tarifa sí se reporta
  });

  it("exención parcial: entre umbrales paga el 50%", () => {
    const r = calcularIsan(120_000, 2099, TARIFA_TEST);
    expect(r.exencion).toBe("PARCIAL");
    expect(r.isan).toBeCloseTo(r.impuestoTarifa * 0.5, 2);
  });

  it("arriba del umbral superior paga completo", () => {
    const r = calcularIsan(120_000.01, 2099, TARIFA_TEST);
    expect(r.exencion).toBeNull();
    expect(r.isan).toBe(r.impuestoTarifa);
  });
});

describe("calcularIsan() — guardias", () => {
  it("precio 0 o negativo → todo en ceros, sin advertencias", () => {
    expect(calcularIsan(0, 2099, TARIFA_TEST).isan).toBe(0);
    expect(calcularIsan(-5, 2099, TARIFA_TEST).isan).toBe(0);
  });

  it("ejercicio sin tarifa → isan 0 con advertencia explícita (nunca inventa)", () => {
    const r = calcularIsan(500_000, 1990);
    expect(r.isan).toBe(0);
    expect(r.advertencias.some((a) => a.includes("Sin tarifa ISAN"))).toBe(true);
  });

  it("tarifa no verificada → advierte que falta cotejo contra DOF", () => {
    const tarifa2026 = getTarifaIsan(2026);
    expect(tarifa2026).not.toBeNull();
    expect(tarifa2026!.verificada).toBe(false);
    const r = calcularIsan(500_000, 2026);
    expect(r.isan).toBeGreaterThan(0);
    expect(r.advertencias.some((a) => a.includes("NO verificada"))).toBe(true);
  });
});
