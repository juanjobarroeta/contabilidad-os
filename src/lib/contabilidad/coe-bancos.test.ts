import { describe, expect, it } from "vitest";
import {
  codigoBancoDesdeClabe,
  codigoBancoDesdeNombre,
  transferenciaParaTx,
  RFC_PUBLICO_GENERAL,
  type TxParaEvidencia,
} from "./coe-bancos";

const cuenta = { banco: "BBVA", numeroCuenta: "0123456789", clabe: "012180001234567895" };

function tx(over: Partial<TxParaEvidencia> = {}): TxParaEvidencia {
  return {
    monto: -5000,
    fecha: new Date("2026-08-15T12:00:00Z"),
    contraparteNombre: "ACEROS DEL NORTE SA",
    contraparteRfc: "AND010101AB1",
    contraparteClabe: "014180655043289761",
    contraparteBanco: null,
    cuenta,
    ...over,
  };
}

describe("codigoBancoDesdeClabe", () => {
  it("los primeros 3 dígitos de una CLABE válida SON el código c_Banco", () => {
    expect(codigoBancoDesdeClabe("012180001234567895")).toBe("012");
    expect(codigoBancoDesdeClabe("014 1806 5504 3289 761".replace(/ /g, ""))).toBe("014");
  });
  it("tolera espacios y rechaza lo que no es CLABE de 18 dígitos", () => {
    expect(codigoBancoDesdeClabe("012 180 001234567895")).toBe("012");
    expect(codigoBancoDesdeClabe("12345")).toBeNull();
    expect(codigoBancoDesdeClabe(null)).toBeNull();
  });
});

describe("codigoBancoDesdeNombre", () => {
  it('acepta el formato "012 BBVA MEXICO" del extractor SPEI', () => {
    expect(codigoBancoDesdeNombre("012 BBVA MEXICO")).toBe("012");
  });
  it("mapea nombres comunes", () => {
    expect(codigoBancoDesdeNombre("BBVA")).toBe("012");
    expect(codigoBancoDesdeNombre("Banorte")).toBe("072");
    expect(codigoBancoDesdeNombre("Citibanamex")).toBe("002");
  });
  it("desconocido → null, jamás inventa", () => {
    expect(codigoBancoDesdeNombre("Banco Pixel SA")).toBeNull();
    expect(codigoBancoDesdeNombre(null)).toBeNull();
  });
});

describe("transferenciaParaTx", () => {
  it("pago (salida): origen = cuenta propia, destino = contraparte", () => {
    const n = transferenciaParaTx(tx())!;
    expect(n.bancoOriNal).toBe("012");
    expect(n.ctaOri).toBe("012180001234567895");
    expect(n.bancoDestNal).toBe("014");
    expect(n.ctaDest).toBe("014180655043289761");
    expect(n.benef).toBe("ACEROS DEL NORTE SA");
    expect(n.rfc).toBe("AND010101AB1");
    expect(n.monto).toBe(5000);
    expect(n.fecha).toBe("2026-08-15");
  });

  it("cobro (entrada): dirección invertida y Benef = razón social propia", () => {
    const n = transferenciaParaTx(tx({ monto: 12000 }), { razonSocialPropia: "MARGOM SA" })!;
    expect(n.bancoOriNal).toBe("014");
    expect(n.bancoDestNal).toBe("012");
    expect(n.ctaDest).toBe("012180001234567895");
    expect(n.benef).toBe("MARGOM SA");
    expect(n.rfc).toBe("AND010101AB1"); // el RFC siempre es del TERCERO
  });

  it("el RFC del CFDI conciliado gana sobre el extraído del SPEI", () => {
    const n = transferenciaParaTx(tx(), { rfcTercero: "XCF010101XX1" })!;
    expect(n.rfc).toBe("XCF010101XX1");
  });

  it("sin RFC por ningún lado → genérico del SAT, nunca vacío", () => {
    const n = transferenciaParaTx(tx({ contraparteRfc: null }))!;
    expect(n.rfc).toBe(RFC_PUBLICO_GENERAL);
  });

  it("banco de la contraparte irresoluble → null (se omite, no se inventa)", () => {
    expect(transferenciaParaTx(tx({ contraparteClabe: null, contraparteBanco: null }))).toBeNull();
  });

  it("pago sin CLABE destino → null (CtaDest es requerido por el XSD)", () => {
    expect(
      transferenciaParaTx(tx({ contraparteClabe: null, contraparteBanco: "014 SANTANDER" })),
    ).toBeNull();
  });

  it("cobro sin CLABE de contraparte pero con banco: CtaOri null (opcional), destino propio", () => {
    const n = transferenciaParaTx(
      tx({ monto: 800, contraparteClabe: null, contraparteBanco: "072 BANORTE" }),
    )!;
    expect(n.ctaOri).toBeNull();
    expect(n.bancoOriNal).toBe("072");
    expect(n.ctaDest).toBe("012180001234567895");
  });

  it("cuenta propia sin CLABE ni banco mapeable → null", () => {
    expect(
      transferenciaParaTx(tx({ cuenta: { banco: "Caja del pueblo", numeroCuenta: "1", clabe: null } })),
    ).toBeNull();
  });
});
