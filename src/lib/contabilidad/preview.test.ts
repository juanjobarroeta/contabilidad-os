import { describe, it, expect } from "vitest";
import { buildEstadoResultadosPreview, type PreviewContribution } from "./posting";

describe("buildEstadoResultadosPreview", () => {
  it("agrupa por cuenta y separa por tipo (INGRESO/COSTO/GASTO)", () => {
    const contribs: PreviewContribution[] = [
      { tipo: "INGRESO", cuentaSAT: "401", subcuenta: "401.01", nombre: "Ventas", monto: 1000 },
      { tipo: "INGRESO", cuentaSAT: "401", subcuenta: "401.01", nombre: "Ventas", monto: 500 },
      { tipo: "GASTO", cuentaSAT: "601", subcuenta: "601.15", nombre: "Combustibles", monto: 200 },
      { tipo: "GASTO", cuentaSAT: "601", subcuenta: "601.01", nombre: "Sueldos", monto: 300 },
      { tipo: "COSTO", cuentaSAT: "501", subcuenta: "501.01", nombre: "Costo de ventas", monto: 400 },
    ];

    const r = buildEstadoResultadosPreview(contribs);

    // Ventas se colapsa en una sola fila de 1500.
    expect(r.ingresos).toHaveLength(1);
    expect(r.ingresos[0].monto).toBe(1500);
    expect(r.totalIngresos).toBe(1500);

    // Dos gastos distintos (combustibles + sueldos).
    expect(r.gastos).toHaveLength(2);
    expect(r.totalGastos).toBe(500);

    // Un costo.
    expect(r.costos).toHaveLength(1);
    expect(r.totalCostos).toBe(400);

    // Utilidad bruta = ingresos − costos; antes de impuestos resta gastos.
    expect(r.utilidadBruta).toBe(1100); // 1500 − 400
    expect(r.utilidadAntesImpuestos).toBe(600); // 1100 − 500
  });

  it("omite filas con monto despreciable (< 0.01)", () => {
    const contribs: PreviewContribution[] = [
      { tipo: "INGRESO", cuentaSAT: "401", subcuenta: "401.01", nombre: "Ventas", monto: 0.004 },
      { tipo: "GASTO", cuentaSAT: "601", subcuenta: "601.01", nombre: "Sueldos", monto: 100 },
    ];
    const r = buildEstadoResultadosPreview(contribs);
    expect(r.ingresos).toHaveLength(0);
    expect(r.gastos).toHaveLength(1);
  });

  it("clasifica como GASTO cualquier tipo que no sea INGRESO/COSTO", () => {
    const contribs: PreviewContribution[] = [
      { tipo: "GASTO", cuentaSAT: "601", subcuenta: "601.99", nombre: "Otros gastos", monto: 50 },
    ];
    const r = buildEstadoResultadosPreview(contribs);
    expect(r.gastos).toHaveLength(1);
    expect(r.ingresos).toHaveLength(0);
    expect(r.costos).toHaveLength(0);
    expect(r.utilidadAntesImpuestos).toBe(-50);
  });

  it("devuelve totales en cero sin contribuciones", () => {
    const r = buildEstadoResultadosPreview([]);
    expect(r.totalIngresos).toBe(0);
    expect(r.totalGastos).toBe(0);
    expect(r.totalCostos).toBe(0);
    expect(r.utilidadAntesImpuestos).toBe(0);
  });
});
