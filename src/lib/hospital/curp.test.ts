import { describe, expect, it } from "vitest";
import { digitoVerificadorCurp, validarCurp } from "./curp";

// CURP de muestra que cumple el dígito verificador oficial (persona ficticia).
const CURP_OK = "SABC560626MDFLRN01";

describe("validarCurp", () => {
  it("acepta una CURP bien formada y extrae fecha, sexo y entidad", () => {
    const r = validarCurp(" sabc560626mdflrn01 ");
    expect(r.valida).toBe(true);
    expect(r.curp).toBe(CURP_OK);
    expect(r.fechaNacimiento?.toISOString().slice(0, 10)).toBe("1956-06-26");
    expect(r.sexo).toBe("FEMENINO");
    expect(r.entidad).toBe("Ciudad de México");
  });

  it("calcula el dígito verificador oficial", () => {
    expect(digitoVerificadorCurp(CURP_OK.slice(0, 17))).toBe("1");
  });

  it("rechaza dígito verificador equivocado con un motivo legible", () => {
    const r = validarCurp("SABC560626MDFLRN09");
    expect(r.valida).toBe(false);
    expect(r.motivo).toMatch(/dígito verificador/);
  });

  it("rechaza longitud y formato", () => {
    expect(validarCurp("").motivo).toMatch(/vacía/);
    expect(validarCurp("SABC560626MDFLRN0").motivo).toMatch(/18/);
    expect(validarCurp("1ABC560626MDFLRN01").valida).toBe(false);
  });

  it("rechaza fechas imposibles dentro de la CURP", () => {
    // 31 de febrero: formato válido, fecha inexistente (dígito recalculado).
    const base = "SABC560231MDFLRN0";
    const curp = base + digitoVerificadorCurp(base);
    const r = validarCurp(curp);
    expect(r.valida).toBe(false);
    expect(r.motivo).toMatch(/no existe/);
  });

  it("distingue el siglo por la posición 17", () => {
    // Nacida en 1985: posición 17 numérica.
    const base = "MAAM850101MDFRRN0";
    const r = validarCurp(base + digitoVerificadorCurp(base));
    expect(r.valida).toBe(true);
    expect(r.fechaNacimiento?.getUTCFullYear()).toBe(1985);
    expect(r.sexo).toBe("FEMENINO");
    expect(r.entidad).toBe("Ciudad de México");
  });
});
