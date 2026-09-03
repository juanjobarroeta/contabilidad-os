import { describe, expect, it } from "vitest";
import { diversificarPorDocumento } from "./diversificar";

const r = (documentId: string, id: string) => ({ documentId, id });

describe("diversificarPorDocumento", () => {
  it("deja pasar a lo más 2 chunks por documento y llena con los siguientes", () => {
    const ordenados = [r("guia", "g1"), r("guia", "g2"), r("guia", "g3"), r("guia", "g4"), r("cff", "c1"), r("guia", "g5"), r("lisr", "l1")];
    expect(diversificarPorDocumento(ordenados, 6).map((x) => x.id)).toEqual(["g1", "g2", "c1", "l1"]);
  });
  it("respeta el límite y el orden de similitud", () => {
    const ordenados = [r("a", "1"), r("b", "2"), r("c", "3"), r("d", "4")];
    expect(diversificarPorDocumento(ordenados, 3).map((x) => x.id)).toEqual(["1", "2", "3"]);
  });
  it("con menos candidatos que el límite devuelve lo que hay", () => {
    expect(diversificarPorDocumento([r("a", "1")], 6)).toHaveLength(1);
  });
});
