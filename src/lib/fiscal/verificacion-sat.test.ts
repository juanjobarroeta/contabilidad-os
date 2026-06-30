import { describe, it, expect } from "vitest";
import {
  clasificarLinea,
  construirVeredicto,
  type VerificacionLinea,
} from "./verificacion-sat";

const linea = (verdict: VerificacionLinea["verdict"]): VerificacionLinea => ({
  clave: "x",
  titulo: "x",
  appValor: null,
  satValor: null,
  diff: null,
  verdict,
  detalle: "",
});

describe("clasificarLinea", () => {
  it("sin_referencia cuando no hay valor del SAT", () => {
    expect(clasificarLinea(1234, null).verdict).toBe("sin_referencia");
  });
  it("ok cuando la diferencia está dentro de la tolerancia", () => {
    expect(clasificarLinea(1000, 1000).verdict).toBe("ok");
    expect(clasificarLinea(1000.5, 1000).verdict).toBe("ok"); // 0.5 ≤ 1
  });
  it("diverge cuando la diferencia supera la tolerancia", () => {
    const c = clasificarLinea(1200, 1000);
    expect(c.verdict).toBe("diverge");
    expect(c.diff).toBe(200);
  });
  it("trata un app nulo como 0 frente a la referencia", () => {
    expect(clasificarLinea(null, 0).verdict).toBe("ok");
    expect(clasificarLinea(null, 500).verdict).toBe("diverge");
  });
});

describe("construirVeredicto", () => {
  it("diverge si ALGUNA línea diverge (aunque falten referencias)", () => {
    expect(construirVeredicto([linea("ok"), linea("diverge"), linea("sin_referencia")])).toBe("diverge");
  });
  it("incompleto si no diverge ninguna pero falta alguna referencia", () => {
    expect(construirVeredicto([linea("ok"), linea("sin_referencia")])).toBe("incompleto");
  });
  it("incompleto cuando no hay líneas", () => {
    expect(construirVeredicto([])).toBe("incompleto");
  });
  it("coincide sólo cuando todas las líneas son comparables y ninguna diverge", () => {
    expect(construirVeredicto([linea("ok"), linea("ok")])).toBe("coincide");
  });
});
