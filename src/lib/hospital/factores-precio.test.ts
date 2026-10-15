import { describe, expect, it } from "vitest";
import { factorPara, leerTabla, precioPorFactor, TABLA_SUGERIDA, tablaSchema } from "./factores-precio";

describe("factores de precio", () => {
  it("el tramo incluye su tope: 15.00 lleva 5, 15.01 lleva 4", () => {
    expect(factorPara(0.01, TABLA_SUGERIDA)).toBe(5);
    expect(factorPara(15, TABLA_SUGERIDA)).toBe(5);
    expect(factorPara(15.01, TABLA_SUGERIDA)).toBe(4);
    expect(factorPara(500, TABLA_SUGERIDA)).toBe(1.6);
    expect(factorPara(500.01, TABLA_SUGERIDA)).toBe(1.5);
    expect(factorPara(2_000_000, TABLA_SUGERIDA)).toBe(1.2);
  });
  it("precio = costo × factor, a centavos", () => {
    expect(precioPorFactor(18.5, TABLA_SUGERIDA)).toBe(74);
    expect(precioPorFactor(128.48, TABLA_SUGERIDA)).toBe(256.96);
    expect(precioPorFactor(249.16, TABLA_SUGERIDA)).toBe(398.66);
  });
  it("valida la tabla: topes crecientes, sólo el último sin tope, factor ≥ 1", () => {
    expect(tablaSchema.safeParse(TABLA_SUGERIDA).success).toBe(true);
    expect(tablaSchema.safeParse([{ hasta: 30, factor: 2 }, { hasta: 15, factor: 3 }]).success).toBe(false);
    expect(tablaSchema.safeParse([{ hasta: null, factor: 2 }, { hasta: 15, factor: 3 }]).success).toBe(false);
    expect(tablaSchema.safeParse([{ hasta: null, factor: 0.8 }]).success).toBe(false);
    expect(leerTabla(null)).toBeNull();
    expect(leerTabla([{ hasta: 10, factor: 2 }])).toEqual([{ hasta: 10, factor: 2 }]);
  });
});
