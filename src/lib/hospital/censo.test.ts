import { describe, it, expect } from "vitest";
import { diaDeEstancia, estanciaPromedio, kpisCenso } from "./censo";
import { fechaLocal } from "./tz";

describe("censo", () => {
  const hoy = fechaLocal(2026, 9, 3, 10, 0);

  it("diaDeEstancia: el día del ingreso es el 1, aunque haya ingresado a las 23:59", () => {
    expect(diaDeEstancia(fechaLocal(2026, 9, 3, 8, 20), hoy)).toBe(1);
    expect(diaDeEstancia(fechaLocal(2026, 9, 2, 8, 20), hoy)).toBe(2);
    expect(diaDeEstancia(fechaLocal(2026, 9, 2, 23, 59), hoy)).toBe(2);
    expect(diaDeEstancia(fechaLocal(2026, 8, 30), hoy)).toBe(5);
    // Ingreso programado a futuro: nunca menos de 1.
    expect(diaDeEstancia(fechaLocal(2026, 9, 5), hoy)).toBe(1);
  });

  it("estanciaPromedio: del ingreso al alta o a hoy, un decimal", () => {
    expect(estanciaPromedio([], hoy)).toBeNull();
    expect(
      estanciaPromedio(
        [
          { fechaIngreso: fechaLocal(2026, 9, 1, 10), fechaAlta: fechaLocal(2026, 9, 3, 10) }, // 2.0
          { fechaIngreso: fechaLocal(2026, 9, 2, 10), fechaAlta: null }, // 1.0 hasta hoy
          { fechaIngreso: fechaLocal(2026, 8, 30, 10), fechaAlta: fechaLocal(2026, 9, 3, 22) }, // 4.5
        ],
        hoy
      )
    ).toBe(2.5);
  });

  it("kpisCenso cuenta camas con episodio, ingresos y altas del día local", () => {
    const k = kpisCenso({
      camas: [
        { estado: "OCUPADA", episodio: { fechaIngreso: fechaLocal(2026, 9, 2) } },
        { estado: "OCUPADA", episodio: { fechaIngreso: fechaLocal(2026, 9, 3) } },
        { estado: "LIMPIEZA", episodio: null },
        { estado: "LIBRE", episodio: null },
      ],
      ingresos: [{ fechaIngreso: fechaLocal(2026, 9, 3, 0, 5) }, { fechaIngreso: fechaLocal(2026, 9, 2, 23, 55) }],
      altas: [{ fechaAlta: fechaLocal(2026, 9, 3, 13, 5) }, { fechaAlta: null }, { fechaAlta: fechaLocal(2026, 9, 1) }],
      estancias: [{ fechaIngreso: fechaLocal(2026, 9, 1, 10), fechaAlta: fechaLocal(2026, 9, 3, 10) }],
      hoy,
    });
    expect(k).toEqual({ ocupadas: 2, camas: 4, pct: 50, ingresosHoy: 1, altasHoy: 1, estanciaPromedio: 2 });
  });

  it("kpisCenso sin camas no divide entre cero", () => {
    expect(kpisCenso({ camas: [], ingresos: [], altas: [], estancias: [], hoy }).pct).toBe(0);
  });
});
