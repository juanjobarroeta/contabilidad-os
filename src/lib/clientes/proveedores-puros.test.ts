import { describe, expect, it } from "vitest";

import { proveedoresPuros } from "./proveedores-puros";

describe("proveedoresPuros", () => {
  it("es puro quien tiene facturas y ninguna que no sea EGRESO", () => {
    const puros = proveedoresPuros(["a", "b", "c"], ["b"]);
    expect([...puros].sort()).toEqual(["a", "c"]);
  });

  it("un alta manual sin facturas no es proveedor puro", () => {
    expect(proveedoresPuros([], []).size).toBe(0);
    expect(proveedoresPuros(["x"], ["x"]).size).toBe(0);
  });

  it("quien es cliente y proveedor a la vez no sale de Clientes", () => {
    expect(proveedoresPuros(["ambos"], ["ambos"]).has("ambos")).toBe(false);
  });
});
