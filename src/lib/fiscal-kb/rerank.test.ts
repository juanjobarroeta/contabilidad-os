import { describe, expect, it } from "vitest";
import { aplicarOrden } from "./rerank";

const cands = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

describe("aplicarOrden", () => {
  it("reordena por número de fragmento (1-based) y manda al final lo no mencionado", () => {
    expect(aplicarOrden([3, 1], cands)?.map((c) => c.id)).toEqual(["c", "a", "b", "d"]);
  });
  it("ignora números fuera de rango y duplicados", () => {
    expect(aplicarOrden([9, 2, 2, 0, 4], cands)?.map((c) => c.id)).toEqual(["b", "d", "a", "c"]);
  });
  it("basura → null (la búsqueda sigue con el orden fusionado)", () => {
    expect(aplicarOrden("no es lista", cands)).toBeNull();
    expect(aplicarOrden([], cands)).toBeNull();
    expect(aplicarOrden(["x", "y"], cands)).toBeNull();
  });
});
