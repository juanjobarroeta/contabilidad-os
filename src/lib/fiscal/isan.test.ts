import { describe, it, expect } from "vitest";
import { calcularIsan, getTarifaIsan, type IsanTarifa } from "./isan";

// Tarifa sintética con números redondos: los tests validan la MECÁNICA del
// Art. 3-I + Art. 8-II sin depender de los montos anuales. La reducción de gama
// alta se ejercita con un umbral bajo ($300k) para no depender de la escala real.
const TARIFA_TEST: IsanTarifa = {
  ejercicio: 2099,
  brackets: [
    { limiteInferior: 0.01, limiteSuperior: 100_000, cuotaFija: 0, tasaExcedente: 0.02 },
    { limiteInferior: 100_000.01, limiteSuperior: 200_000, cuotaFija: 2_000, tasaExcedente: 0.05 },
    { limiteInferior: 200_000.01, limiteSuperior: null, cuotaFija: 7_000, tasaExcedente: 0.17 },
  ],
  exencionTotalHasta: 80_000,
  exencionParcialHasta: 120_000,
  reduccionLujoDesde: 300_000,
  reduccionLujoTasa: 0.07,
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

  it("precio justo en el límite superior de un bracket se queda en ese bracket", () => {
    // 200,000 = límiteSuperior del bracket 2 (no salta al 3).
    const r = calcularIsan(200_000, 2099, TARIFA_TEST);
    expect(r.impuestoTarifa).toBeCloseTo(2_000 + (200_000 - 100_000.01) * 0.05, 2);
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

  it("arriba del umbral superior paga completo (sin reducción de gama alta)", () => {
    const r = calcularIsan(120_000.01, 2099, TARIFA_TEST);
    expect(r.exencion).toBeNull();
    expect(r.reduccionLujo).toBe(0);
    expect(r.isan).toBe(r.impuestoTarifa);
  });
});

describe("calcularIsan() — reducción de gama alta (nota Anexo 15-A)", () => {
  it("no aplica por debajo del umbral", () => {
    const r = calcularIsan(299_999, 2099, TARIFA_TEST);
    expect(r.reduccionLujo).toBe(0);
    expect(r.isan).toBe(r.impuestoTarifa);
  });

  it("reduce el impuesto en el 7% del excedente sobre el umbral", () => {
    const r = calcularIsan(500_000, 2099, TARIFA_TEST);
    const reduccionEsperada = (500_000 - 300_000) * 0.07;
    expect(r.reduccionLujo).toBeCloseTo(reduccionEsperada, 2);
    expect(r.isan).toBeCloseTo(r.impuestoTarifa - reduccionEsperada, 2);
  });

  it("la reducción nunca deja el impuesto por debajo de cero", () => {
    // Excedente enorme → reducción teórica > impuesto; se limita al impuesto.
    const r = calcularIsan(50_000_000, 2099, TARIFA_TEST);
    expect(r.reduccionLujo).toBeLessThanOrEqual(r.impuestoTarifa);
    expect(r.isan).toBeGreaterThanOrEqual(0);
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

});

describe("tarifa oficial 2026 (Anexo 15 RMF, DOF 28-dic-2025)", () => {
  it("está marcada como verificada (sin advertencia de cotejo)", () => {
    const t = getTarifaIsan(2026);
    expect(t).not.toBeNull();
    expect(t!.verificada).toBe(true);
    const r = calcularIsan(600_000, 2026);
    expect(r.advertencias).toHaveLength(0);
  });

  it("exención total para precio ≤ $356,934.05 (Art. 8-II primer párrafo)", () => {
    expect(calcularIsan(356_934.05, 2026).exencion).toBe("TOTAL");
    expect(calcularIsan(356_934.05, 2026).isan).toBe(0);
    expect(calcularIsan(356_934.06, 2026).exencion).toBe("PARCIAL");
  });

  it("exención parcial hasta $452,116.48; arriba paga completo", () => {
    expect(calcularIsan(452_116.48, 2026).exencion).toBe("PARCIAL");
    expect(calcularIsan(452_116.49, 2026).exencion).toBeNull();
  });

  it("calcula el impuesto de un auto de $600,000 con la tarifa oficial", () => {
    // Bracket 4: 537,516.65–691,092.34 → 19,197.04 + 15% de (600,000 − 537,516.65)
    const r = calcularIsan(600_000, 2026);
    const esperado = 19_197.04 + (600_000 - 537_516.65) * 0.15;
    expect(r.impuestoTarifa).toBeCloseTo(esperado, 2);
    expect(r.reduccionLujo).toBe(0);
    expect(r.isan).toBeCloseTo(esperado, 2);
  });

  it("aplica la reducción del 7% arriba de $1,060,189.93", () => {
    const precio = 1_500_000;
    const r = calcularIsan(precio, 2026);
    // Bracket 5: 42,233.35 + 17% de (precio − 691,092.35)
    const impuesto = 42_233.35 + (precio - 691_092.35) * 0.17;
    const reduccion = (precio - 1_060_189.93) * 0.07;
    expect(r.impuestoTarifa).toBeCloseTo(impuesto, 2);
    expect(r.reduccionLujo).toBeCloseTo(reduccion, 2);
    expect(r.isan).toBeCloseTo(impuesto - reduccion, 2);
  });
});
