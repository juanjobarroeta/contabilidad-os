import { describe, expect, it } from "vitest";
import { ejerciciosAnualesPendientes } from "./anual";

describe("ejerciciosAnualesPendientes", () => {
  const sin = new Map<number, { conPdf: boolean }>();
  it("en octubre el último ejercicio exigible es el anterior; 5 años, sin inicio", () => {
    expect(ejerciciosAnualesPendientes({ hoy: new Date(2026, 9, 5), anios: 5, inicio: null, existentes: sin })).toEqual([2025, 2024, 2023, 2022, 2021]);
  });
  it("antes de mayo todavía no se exige la del ejercicio anterior", () => {
    expect(ejerciciosAnualesPendientes({ hoy: new Date(2026, 2, 10), anios: 2, inicio: null, existentes: sin })).toEqual([2024]);
  });
  it("se acota al inicio de operaciones", () => {
    expect(ejerciciosAnualesPendientes({ hoy: new Date(2026, 9, 5), anios: 5, inicio: new Date(2024, 3, 1), existentes: sin })).toEqual([2025, 2024]);
  });
  it("una fila con PDF ya no se pide; sin PDF sí", () => {
    const ex = new Map([[2025, { conPdf: true }], [2024, { conPdf: false }]]);
    expect(ejerciciosAnualesPendientes({ hoy: new Date(2026, 9, 5), anios: 3, inicio: null, existentes: ex })).toEqual([2024, 2023]);
  });
});
