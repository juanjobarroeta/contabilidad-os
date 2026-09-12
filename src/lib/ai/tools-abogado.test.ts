import { describe, expect, it } from "vitest";
import { toolsAbogado } from "./tools-abogado";
import { tools } from "./tools";

describe("toolsAbogado", () => {
  it("sólo conocimiento: sin datos de empresa ni acciones proponer_*", () => {
    const nombres = toolsAbogado.map((t) => t.name);
    expect(nombres.sort()).toEqual(["get_articulo", "get_tesis", "get_valor_fiscal", "search_fiscal_knowledge", "search_jurisprudencia"]);
    expect(nombres.some((n) => n.startsWith("proponer_") || n.startsWith("query_"))).toBe(false);
  });
  it("get_articulo acepta cualquier clave del catálogo (sin enum: son más de mil)", () => {
    const ga = toolsAbogado.find((t) => t.name === "get_articulo")!;
    const props = (ga.input_schema as { properties: Record<string, { enum?: string[]; description?: string }> }).properties;
    expect(props.ley.enum).toBeUndefined();
    expect(props.ley.description).toMatch(/CNPCF/);
    // El contador sigue con su lista corta.
    const gaContador = tools.find((t) => t.name === "get_articulo")!;
    const propsC = (gaContador.input_schema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(propsC.ley.enum).not.toContain("CNPCF");
  });
  it("la búsqueda normativa describe el corpus completo", () => {
    const s = toolsAbogado.find((t) => t.name === "search_fiscal_knowledge")!;
    expect(s.description).toMatch(/TODO el orden jurídico/);
  });
});
