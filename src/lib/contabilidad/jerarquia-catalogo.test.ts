import { describe, it, expect } from "vitest";
import { esAncestro, padresDelCatalogo, segmentosDeCodigo } from "./jerarquia-catalogo";

describe("segmentosDeCodigo — las tres formas que traen los catálogos", () => {
  it("con separador, y los grupos finales en cero son relleno", () => {
    expect(segmentosDeCodigo("102.01.001")).toEqual(["102", "01", "001"]);
    expect(segmentosDeCodigo("2110-002-000")).toEqual(["2110", "002"]);
    expect(segmentosDeCodigo("1000-0001-0000")).toEqual(["1000", "0001"]);
    expect(segmentosDeCodigo("100-01")).toEqual(["100", "01"]);
  });
  it("nueve dígitos en grupos de tres (CENTRO)", () => {
    expect(segmentosDeCodigo("115001001")).toEqual(["115", "001", "001"]);
    expect(segmentosDeCodigo("115001000")).toEqual(["115", "001"]);
    expect(segmentosDeCodigo("115000000")).toEqual(["115"]);
  });
  it("numérico corto queda entero; vacío → nada", () => {
    expect(segmentosDeCodigo("10010")).toEqual(["10010"]);
    expect(segmentosDeCodigo("")).toEqual([]);
  });
});

describe("padresDelCatalogo — quién tiene subcuentas", () => {
  it("CENTRO: la subcuenta con detalle es padre; el detalle no; cuenta lo que cuelga", () => {
    const p = padresDelCatalogo([
      { codigo: "115000000", nivel: 1 },
      { codigo: "115001000", nivel: 2 },
      { codigo: "115001001", nivel: 3 },
      { codigo: "115001002", nivel: 3 },
      { codigo: "115002000", nivel: 2 },
    ]);
    expect(p.get("115000000")).toBe(4);
    expect(p.get("115001000")).toBe(2);
    expect(p.has("115001001")).toBe(false);
    expect(p.has("115002000")).toBe(false);
  });
  it("con separador (BAOBAB, dotted) y el starter «101» junto a los códigos de la empresa", () => {
    const p = padresDelCatalogo([
      { codigo: "2110-000-000", nivel: 1 },
      { codigo: "2110-002-000", nivel: 2 },
      { codigo: "2110-002-001", nivel: 3 },
      { codigo: "102", nivel: 2 },
      { codigo: "102.01", nivel: 3 },
      { codigo: "102.01.01", nivel: 4 },
      // starter «101» (nivel 2) convive con «101001000» (nivel 2): mismo nivel, no es su padre
      { codigo: "101", nivel: 2 },
      { codigo: "101001000", nivel: 2 },
    ]);
    expect([...p.keys()].sort()).toEqual(["102", "102.01", "2110-000-000", "2110-002-000"]);
    expect(p.get("2110-000-000")).toBe(2);
    expect(p.get("102")).toBe(2);
  });
  it("numérico corto: el prefijo manda, siempre que la hija esté en un nivel mayor", () => {
    const p = padresDelCatalogo([
      { codigo: "1001", nivel: 2 },
      { codigo: "10010", nivel: 3 },
      { codigo: "10011", nivel: 3 },
      { codigo: "1002", nivel: 2 },
    ]);
    expect(p.get("1001")).toBe(2);
    expect(p.has("1002")).toBe(false);
  });
  it("catálogo plano: nadie es padre", () => {
    expect(padresDelCatalogo([{ codigo: "601.01", nivel: 3 }, { codigo: "601.02", nivel: 3 }]).size).toBe(0);
  });
});

describe("esAncestro", () => {
  it("nivel mayor y código que desciende", () => {
    expect(esAncestro({ codigo: "501001000", nivel: 2 }, { codigo: "501001003", nivel: 3 })).toBe(true);
    expect(esAncestro({ codigo: "501001000", nivel: 2 }, { codigo: "501002001", nivel: 3 })).toBe(false);
    expect(esAncestro({ codigo: "101", nivel: 2 }, { codigo: "101001000", nivel: 2 })).toBe(false);
    expect(esAncestro({ codigo: "1001", nivel: 2 }, { codigo: "10010", nivel: 3 })).toBe(true);
  });
});
