import { describe, it, expect } from "vitest";
import { agrupadorEmitido, codigoDeCuenta, esAgrupadorOficial, sinAgrupadorValido } from "./agrupador";

describe("agrupador", () => {
  it("sin subcuenta, el número de mayor es el código", () => {
    expect(codigoDeCuenta({ cuentaSAT: "102", subcuenta: null })).toBe("102");
  });

  it("una subcuenta VACÍA no es una subcuenta", () => {
    // Con `??` la cadena vacía ganaba y el código emitido salía en blanco: la
    // cuenta se contaba como «sin agrupador» aunque su número fuera válido.
    expect(codigoDeCuenta({ cuentaSAT: "102", subcuenta: "" })).toBe("102");
    expect(sinAgrupadorValido({ cuentaSAT: "102", subcuenta: "" })).toBe(false);
  });

  it("recorta espacios antes de cotejar contra el Anexo 24", () => {
    expect(sinAgrupadorValido({ cuentaSAT: "9999", codAgrup: " 102.01 " })).toBe(false);
  });

  it("el codAgrup declarado manda sobre el número propio", () => {
    expect(agrupadorEmitido({ cuentaSAT: "1301-0028-0000", codAgrup: "105.01" })).toBe("105.01");
  });

  it("el número propio de la empresa no es un agrupador", () => {
    expect(sinAgrupadorValido({ cuentaSAT: "1301-0028-0000", codAgrup: null })).toBe(true);
  });

  it("un codAgrup inventado tampoco lo es", () => {
    expect(esAgrupadorOficial("999.99")).toBe(false);
    expect(sinAgrupadorValido({ cuentaSAT: "102", codAgrup: "999.99" })).toBe(true);
  });
});
