import { describe, expect, it } from "vitest";
import { MULTAS_CFF, buscarMulta, coberturaMultasCFF, multasVigentes } from "./multas";

describe("multas CFF (datos generados del Anexo 5)", () => {
  it("hay tabla 2026 vigente desde el 1-ene-2026, verificada", () => {
    const t = multasVigentes("2026-09-04");
    expect(t?.ejercicio).toBe(2026);
    expect(t?.verificado).toBe(true);
    expect(multasVigentes("2019-01-01")).toBeNull();
  });
  it("Art. 82-I-a: $2,050 a $25,360 (no presentar declaración)", () => {
    const r = buscarMulta({ articulo: "82", fraccion: "I", inciso: "a", fecha: "2026-03-01" });
    expect(r?.filas).toHaveLength(1);
    expect(r?.filas[0]).toMatchObject({ minimo: 2050, maximo: 25360, seccion: "A" });
  });
  it("acepta «Art. 82» y prefiere la sección A cuando A y B repiten la ubicación", () => {
    const r = buscarMulta({ articulo: "Art. 82", fraccion: "I" });
    expect(r?.filas.every((f) => f.seccion === "A")).toBe(true);
    expect(r?.filas.map((f) => f.inciso)).toContain("d");
  });
  it("artículo sin filas → lista vacía, no null", () => {
    expect(buscarMulta({ articulo: "999" })?.filas).toEqual([]);
  });
  it("cobertura reporta el último ejercicio", () => {
    expect(coberturaMultasCFF()).toEqual({ ejercicio: Math.max(...MULTAS_CFF.map((m) => m.ejercicio)), verificado: true });
  });
});
