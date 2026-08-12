import { describe, expect, it } from "vitest";
import {
  esRfcGenerico,
  nombreContraparte,
  rfcContraparte,
  RFC_PUBLICO_GENERAL,
} from "./contraparte";

describe("nombreContraparte", () => {
  it("prefiere el Customer cuando existe", () => {
    const inv = {
      customer: { razonSocial: "ACME SA DE CV", rfc: "ACM010101AAA" },
      contraparteNombre: "NOMBRE VIEJO DEL XML",
      contraparteRfc: "ACM010101AAA",
    };
    expect(nombreContraparte(inv)).toBe("ACME SA DE CV");
  });

  it("cae al nombre del comprobante cuando no hay Customer (público en general)", () => {
    // Caso real: CFDI a XAXX010101000 con nombre del comprador en el XML.
    const inv = {
      customer: null,
      contraparteNombre: "JESUS HERNANDEZ SANCHEZ",
      contraparteRfc: RFC_PUBLICO_GENERAL,
    };
    expect(nombreContraparte(inv)).toBe("JESUS HERNANDEZ SANCHEZ");
    expect(rfcContraparte(inv)).toBe(RFC_PUBLICO_GENERAL);
  });

  it("devuelve el marcador cuando no hay ninguno de los dos", () => {
    expect(nombreContraparte({ customer: null })).toBe("—");
    expect(rfcContraparte({ customer: null })).toBe("—");
  });

  it("trata el nombre vacío o en blanco como ausente", () => {
    expect(nombreContraparte({ customer: null, contraparteNombre: "   " })).toBe("—");
  });

  it("respeta el marcador personalizado (p. ej. cadena vacía para CSV)", () => {
    expect(nombreContraparte({ customer: null }, "")).toBe("");
  });
});

describe("esRfcGenerico", () => {
  it("reconoce público en general y extranjero", () => {
    expect(esRfcGenerico({ customer: null, contraparteRfc: "XAXX010101000" })).toBe(true);
    expect(esRfcGenerico({ customer: null, contraparteRfc: "XEXX010101000" })).toBe(true);
  });

  it("un RFC real no es genérico", () => {
    expect(esRfcGenerico({ customer: { razonSocial: "ACME", rfc: "ACM010101AAA" } })).toBe(false);
    expect(esRfcGenerico({ customer: null })).toBe(false);
  });
});
