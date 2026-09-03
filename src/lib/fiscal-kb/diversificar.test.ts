import { describe, expect, it } from "vitest";
import { diversificarPorUnidad } from "./diversificar";

const guia = (documentId: string, id: string) => ({ documentId, articulo: null, id });
const art = (documentId: string, articulo: string, id: string) => ({ documentId, articulo, id });

describe("diversificarPorUnidad", () => {
  it("una guía (sin artículos) deja pasar a lo más 2 chunks y llena con los siguientes", () => {
    const ordenados = [guia("guia", "g1"), guia("guia", "g2"), guia("guia", "g3"), guia("guia", "g4"), art("cff", "29-A", "c1"), guia("guia", "g5"), art("lisr", "27", "l1")];
    expect(diversificarPorUnidad(ordenados, 6).map((x) => x.id)).toEqual(["g1", "g2", "c1", "l1"]);
  });
  it("artículos distintos de la MISMA ley no compiten entre sí (regresión de la Fase 1a)", () => {
    const ordenados = ["10", "81", "9", "25", "27", "28", "30"].map((a, i) => art("lisr", a, `l${i}`));
    expect(diversificarPorUnidad(ordenados, 6)).toHaveLength(6);
    expect(diversificarPorUnidad(ordenados, 6).map((x) => x.articulo)).toEqual(["10", "81", "9", "25", "27", "28"]);
  });
  it("las partes de un artículo largo sí se capan a 2", () => {
    const ordenados = [art("lisr", "27", "p1"), art("lisr", "27", "p2"), art("lisr", "27", "p3"), art("lisr", "28", "x"), art("lisr", "27", "p4")];
    expect(diversificarPorUnidad(ordenados, 6).map((x) => x.id)).toEqual(["p1", "p2", "x"]);
  });
  it("respeta el límite y el orden de similitud", () => {
    const ordenados = [art("a", "1", "1"), art("b", "1", "2"), art("c", "1", "3"), art("d", "1", "4")];
    expect(diversificarPorUnidad(ordenados, 3).map((x) => x.id)).toEqual(["1", "2", "3"]);
  });
  it("con menos candidatos que el límite devuelve lo que hay", () => {
    expect(diversificarPorUnidad([art("a", "1", "1")], 6)).toHaveLength(1);
  });
});
