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

describe("búsqueda por importe — la caja lo ofrece, ahora lo cumple", () => {
  const totalDe = (q: string) => {
    const w = whereBusquedaFacturas(q);
    const grupos = (w?.AND ?? []) as Array<{ OR: Array<Record<string, unknown>> }>;
    return grupos.flatMap((g) => g.OR).filter((c) => "total" in c).map((c) => c.total);
  };

  it("con decimales busca el importe exacto", () => {
    expect(totalDe("4989.20")).toEqual([{ gte: 4989.195, lte: 4989.205 }]);
  });

  it("sin decimales toma la parte entera: 4989 encuentra 4,989.20", () => {
    expect(totalDe("4989")).toEqual([{ gte: 4989, lt: 4990 }]);
  });

  it("ignora el signo de pesos y las comas", () => {
    expect(totalDe("$4,989.20")).toEqual([{ gte: 4989.195, lte: 4989.205 }]);
  });

  it("una palabra que no es número no genera rango", () => {
    expect(totalDe("farmadrogueria")).toEqual([]);
    expect(totalDe("W-7346")).toEqual([]);
  });

  it("el importe convive con el nombre: ambas palabras deben aparecer", () => {
    const w = whereBusquedaFacturas("medina 4989.20");
    expect((w?.AND as unknown[])?.length).toBe(2);
  });

  it("sigue buscando texto en todos los campos de siempre", () => {
    const w = whereBusquedaFacturas("bilbao");
    const campos = ((w?.AND as Array<{ OR: Array<Record<string, unknown>> }>)[0].OR).map((c) => Object.keys(c)[0]);
    expect(campos).toContain("uuid");
    expect(campos).toContain("customer");
    expect(campos).toContain("contraparteNombre");
    expect(campos).not.toContain("total");
  });
});
