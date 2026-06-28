import { describe, it, expect } from "vitest";
import { validarCfdiInput } from "./validacion";
import type { CfdiInput } from "./types";

const valido: CfdiInput = {
  customerRef: "x",
  receptor: { rfc: "ACI0307141W9", nombre: "ADET CONSTRUCCION", regimenFiscal: "601", domicilioFiscalCP: "72830" },
  paymentForm: "03",
  paymentMethod: "PUE",
  use: "G03",
  items: [{ quantity: 1, product: { description: "Servicio", product_key: "84111506", price: 100 } }],
};

describe("validarCfdiInput", () => {
  it("acepta un CFDI bien formado", () => {
    expect(validarCfdiInput(valido)).toEqual([]);
  });

  it("rechaza forma de pago, uso y método inválidos", () => {
    const errs = validarCfdiInput({ ...valido, paymentForm: "00", use: "ZZZ", paymentMethod: "XXX" as never });
    expect(errs.length).toBeGreaterThanOrEqual(3);
  });

  it("rechaza receptor con RFC, régimen o CP inválidos", () => {
    const errs = validarCfdiInput({
      ...valido,
      receptor: { rfc: "MAL", nombre: "", regimenFiscal: "999", domicilioFiscalCP: "7" },
    });
    expect(errs.some((e) => e.includes("RFC"))).toBe(true);
    expect(errs.some((e) => e.includes("Régimen"))).toBe(true);
    expect(errs.some((e) => e.includes("postal"))).toBe(true);
    expect(errs.some((e) => e.includes("nombre"))).toBe(true);
  });

  it("rechaza ClaveProdServ mal formada y cantidad 0", () => {
    const errs = validarCfdiInput({
      ...valido,
      items: [{ quantity: 0, product: { description: "x", product_key: "123", price: 10 } }],
    });
    expect(errs.some((e) => e.includes("ClaveProdServ"))).toBe(true);
    expect(errs.some((e) => e.includes("cantidad"))).toBe(true);
  });
});
