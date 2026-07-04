// ─── Pruebas: días trabajados dentro de un ejercicio (corridas especiales) ───
// Insumo de la proporcionalidad del aguinaldo (Art. 87 LFT) y del reparto de
// PTU por días (Art. 123 LFT). Convenciones documentadas en
// corridas-especiales.ts: conteo inclusivo alta→baja/31-dic, tope 365 aun en
// bisiestos (consistente con el divisor 365).

import { describe, it, expect } from "vitest";
import { diasTrabajadosEnEjercicio } from "./corridas-especiales";

describe("diasTrabajadosEnEjercicio", () => {
  it("alta anterior al ejercicio, sin baja: año completo (365)", () => {
    expect(diasTrabajadosEnEjercicio(new Date("2020-05-10"), null, 2026)).toBe(365);
  });

  it("alta a mitad del ejercicio (1-jul): 184 días", () => {
    expect(diasTrabajadosEnEjercicio(new Date("2026-07-01"), null, 2026)).toBe(184);
  });

  it("alta en noviembre (15-nov): 47 días", () => {
    expect(diasTrabajadosEnEjercicio(new Date("2026-11-15"), null, 2026)).toBe(47);
  });

  it("alta posterior al ejercicio: 0 días", () => {
    expect(diasTrabajadosEnEjercicio(new Date("2027-01-10"), null, 2026)).toBe(0);
  });

  it("baja dentro del ejercicio: cuenta hasta la baja (1-ene a 1-mar = 60)", () => {
    expect(
      diasTrabajadosEnEjercicio(new Date("2026-01-01"), new Date("2026-03-01"), 2026)
    ).toBe(60);
  });

  it("baja anterior al ejercicio: 0 días", () => {
    expect(
      diasTrabajadosEnEjercicio(new Date("2020-01-01"), new Date("2025-06-30"), 2026)
    ).toBe(0);
  });

  it("año bisiesto completo: tope 365 (divisor del Art. 87, simplificación documentada)", () => {
    expect(diasTrabajadosEnEjercicio(new Date("2020-01-01"), null, 2024)).toBe(365);
  });
});
