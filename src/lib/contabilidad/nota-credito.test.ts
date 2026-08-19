import { describe, it, expect } from "vitest";
import { esComprobanteDeEgreso, espejo, signoDeComprobante } from "./nota-credito";

describe("esComprobanteDeEgreso()", () => {
  it("reconoce la E, tolerando espacios y minúsculas del origen", () => {
    expect(esComprobanteDeEgreso({ tipoSat: "E" })).toBe(true);
    expect(esComprobanteDeEgreso({ tipoSat: " e " })).toBe(true);
  });

  it("la factura, la nómina y el CFDI sin tipo no son egresos", () => {
    expect(esComprobanteDeEgreso({ tipoSat: "I" })).toBe(false);
    expect(esComprobanteDeEgreso({ tipoSat: "N" })).toBe(false);
    expect(esComprobanteDeEgreso({ tipoSat: "P" })).toBe(false);
    expect(esComprobanteDeEgreso({ tipoSat: null })).toBe(false);
    expect(esComprobanteDeEgreso({})).toBe(false);
  });
});

describe("espejo()", () => {
  it("el egreso invierte el asiento: lo que se abonó se carga", () => {
    expect(espejo("ABONO", true)).toBe("CARGO");
    expect(espejo("CARGO", true)).toBe("ABONO");
  });

  it("la factura normal no se toca", () => {
    expect(espejo("ABONO", false)).toBe("ABONO");
    expect(espejo("CARGO", false)).toBe("CARGO");
  });

  it("aplicado dos veces regresa al original (es una involución)", () => {
    expect(espejo(espejo("CARGO", true), true)).toBe("CARGO");
  });
});

describe("signoDeComprobante()", () => {
  it("la nota resta donde la factura suma", () => {
    expect(signoDeComprobante(true)).toBe(-1);
    expect(signoDeComprobante(false)).toBe(1);
  });
});
