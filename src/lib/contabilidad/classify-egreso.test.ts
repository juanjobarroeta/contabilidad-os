import { describe, it, expect } from "vitest";
import { classifyEgreso } from "./classify-egreso";
import { COE_CODES } from "./catalog";

describe("classifyEgreso", () => {
  it("831018 (CFE) es energía eléctrica, no agua", () => {
    // CFE factura con 83101800; el prefijo corto 83101 (agua) se lo comía y
    // cada recibo de luz se contabilizaba como agua.
    expect(classifyEgreso("83101800").cuenta).toBe("601.52");
    expect(classifyEgreso("83101501").cuenta).toBe("601.51"); // agua sigue siendo agua
  });

  it("reparte los conceptos típicos de una PyME en cuentas distintas", () => {
    const cuentas = new Set(
      ["80131502", "15101514", "81161700", "80101500", "83101800", "44121600", "72101511", "82101500"]
        .map((clave) => classifyEgreso(clave).cuenta)
    );
    expect(cuentas.size).toBe(8);
  });

  it("sin clave cae en otros gastos", () => {
    expect(classifyEgreso("").cuenta).toBe(COE_CODES.OTROS_GASTOS);
  });
});
