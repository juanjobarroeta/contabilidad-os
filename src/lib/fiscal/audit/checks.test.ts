import { describe, it, expect, vi } from "vitest";

// Mock del catálogo de reglas para probar los checks de forma aislada.
vi.mock("../rules", () => ({
  getRule: (key: string) => {
    if (key === "isr.deduccion.combustible.requiere_medio_electronico")
      return { valor: true, fundamento: { ley: "LISR", articulo: "27", fraccion: "III" } };
    if (key === "isr.deduccion.limite_efectivo")
      return { valor: 2000, fundamento: { ley: "LISR", articulo: "27", fraccion: "III" } };
    return null;
  },
  aplicaAplicabilidad: () => true,
}));

import { CHECKS } from "./checks";
import type { CfdiNormalizado } from "./types";

const ctx = {} as never;
const combustible = (id: string, total: number, formaPago = "01"): CfdiNormalizado => ({
  id,
  direccion: "RECIBIDA",
  fecha: "2026-06-01",
  formaPago,
  total,
  items: [{ claveProdServ: "15101500", descripcion: "Gasolina" }],
});

const checkCombustible = CHECKS.find((c) => c.clave === "deduccion.combustible.efectivo")!;
const checkEfectivo = CHECKS.find((c) => c.clave === "deduccion.efectivo.limite")!;

describe("checks agregados — un solo hallazgo por empresa", () => {
  it("combustible: agrega N CFDIs en un hallazgo con dedupeRef estable", () => {
    const out = checkCombustible.evaluar([combustible("a", 200), combustible("b", 300)], ctx);
    expect(out).toHaveLength(1);
    expect([...out[0].referencias].sort()).toEqual(["a", "b"]);
    expect(out[0].dedupeRef).toBe("deduccion.combustible.efectivo");
    expect(out[0].mensaje).toContain("2 CFDIs");
    expect(out[0].mensaje).toContain("500"); // total agregado
  });

  it("combustible: sin efectivo no marca", () => {
    expect(checkCombustible.evaluar([combustible("a", 200, "03")], ctx)).toHaveLength(0);
  });

  it("efectivo>límite: no duplica el combustible (lo excluye) y agrega el resto", () => {
    const noCombustible: CfdiNormalizado = {
      id: "g", direccion: "RECIBIDA", fecha: "2026-06-01", formaPago: "01", total: 5000,
      items: [{ claveProdServ: "01010101", descripcion: "Papelería" }],
    };
    const out = checkEfectivo.evaluar([combustible("a", 9000), noCombustible], ctx);
    expect(out).toHaveLength(1);
    expect(out[0].referencias).toEqual(["g"]); // el combustible no entra aquí
    expect(out[0].dedupeRef).toBe("deduccion.efectivo.limite");
  });
});
