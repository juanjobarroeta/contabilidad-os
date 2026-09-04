import { describe, expect, it } from "vitest";
import { tokensDeBusqueda, whereBusquedaFacturas } from "./busqueda";

describe("tokensDeBusqueda", () => {
  it("parte por espacios y quita vacíos y repetidos", () => {
    expect(tokensDeBusqueda("  victor   bilbao  ")).toEqual(["victor", "bilbao"]);
    expect(tokensDeBusqueda("Bilbao bilbao BILBAO")).toEqual(["Bilbao"]);
    expect(tokensDeBusqueda("")).toEqual([]);
    expect(tokensDeBusqueda(null)).toEqual([]);
  });

  it("acota a ocho palabras", () => {
    expect(tokensDeBusqueda("a b c d e f g h i j")).toHaveLength(8);
  });
});

describe("whereBusquedaFacturas", () => {
  it("sin consulta no filtra", () => {
    expect(whereBusquedaFacturas("")).toBeNull();
    expect(whereBusquedaFacturas("   ")).toBeNull();
  });

  it("cada palabra es un grupo OR y todas van en AND", () => {
    const w = whereBusquedaFacturas("victor bilbao");
    expect(w).not.toBeNull();
    const grupos = (w as { AND: Array<{ OR: unknown[] }> }).AND;
    expect(grupos).toHaveLength(2);
    // Cada grupo busca su palabra en todos los campos (nombre, RFC, folio…).
    for (const g of grupos) expect(g.OR.length).toBeGreaterThanOrEqual(7);
    const texto = JSON.stringify(w);
    expect(texto).toContain('"victor"');
    expect(texto).toContain('"bilbao"');
    expect(texto).toContain('"insensitive"');
  });

  it("una sola palabra sigue buscando por UUID y folio", () => {
    const w = whereBusquedaFacturas("A1B2C3") as { AND: Array<{ OR: Array<Record<string, unknown>> }> };
    const campos = w.AND[0].OR.flatMap((c) => Object.keys(c));
    expect(campos).toEqual(expect.arrayContaining(["uuid", "folio", "customer", "contraparteNombre"]));
  });
});
