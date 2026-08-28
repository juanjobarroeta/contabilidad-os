import { describe, it, expect } from "vitest";
import { cpReceptorDesdeXml } from "./cp-receptor";

describe("cpReceptorDesdeXml", () => {
  it("extrae el CP del DomicilioFiscalReceptor", () => {
    const xml = '<cfdi:Receptor Rfc="ABJ080312HA1" Nombre="ACEROS" DomicilioFiscalReceptor="72810" RegimenFiscalReceptor="601" UsoCFDI="G03"/>';
    expect(cpReceptorDesdeXml(xml)).toBe("72810");
  });

  it("null cuando no hay atributo, el XML es nulo o el valor no es un CP", () => {
    expect(cpReceptorDesdeXml('<cfdi:Receptor Rfc="X"/>')).toBeNull();
    expect(cpReceptorDesdeXml(null)).toBeNull();
    expect(cpReceptorDesdeXml('<x DomicilioFiscalReceptor="ABCDE"/>')).toBeNull();
  });
});
