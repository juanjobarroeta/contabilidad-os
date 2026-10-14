import { describe, it, expect } from "vitest";
import { origenDe, pasaOrigen, repartirPorAlmacen, SIN_ALMACEN } from "./farmacia-almacenes";

describe("origenDe()", () => {
  it("cargado a mano o del inventario → INVENTARIO; derivado de CFDI sin lotes → CFDI; derivado con lote → INVENTARIO", () => {
    expect(origenDe({ derivadoDeCfdi: false, lotes: 0 })).toBe("INVENTARIO");
    expect(origenDe({ derivadoDeCfdi: true, lotes: 0 })).toBe("CFDI");
    expect(origenDe({ derivadoDeCfdi: true, lotes: 2 })).toBe("INVENTARIO");
  });
  it("TODOS deja pasar ambos", () => {
    expect(pasaOrigen("TODOS", "CFDI")).toBe(true);
    expect(pasaOrigen("INVENTARIO", "CFDI")).toBe(false);
  });
});

describe("repartirPorAlmacen()", () => {
  const lotes = new Map([
    ["l1", { almacen: "ALMACEN GENERAL", costoUnitario: 10 }],
    ["l2", { almacen: "CEYE", costoUnitario: 20 }],
    ["l3", { almacen: "ALMACEN GENERAL", costoUnitario: 5 }],
  ]);
  const movs = [
    { insumoId: "a", loteId: "l1", cantidad: 8 },
    { insumoId: "a", loteId: "l2", cantidad: 3 },
    { insumoId: "b", loteId: "l3", cantidad: 4 },
    { insumoId: "b", loteId: null, cantidad: 2 }, // entrada derivada de CFDI, sin lote
    { insumoId: "c", loteId: "l2", cantidad: 0 },
  ];

  it("reparte el kardex por el almacén del lote; sin lote → SIN ALMACÉN", () => {
    const { porInsumo } = repartirPorAlmacen(movs, lotes);
    expect(Object.fromEntries(porInsumo.get("a")!)).toEqual({ "ALMACEN GENERAL": 8, CEYE: 3 });
    expect(Object.fromEntries(porInsumo.get("b")!)).toEqual({ "ALMACEN GENERAL": 4, [SIN_ALMACEN]: 2 });
  });

  it("el resumen cuenta productos con piezas > 0, suma piezas y valor a costo del lote; SIN ALMACÉN al final", () => {
    const { resumen } = repartirPorAlmacen(movs, lotes);
    expect(resumen).toEqual([
      { almacen: "ALMACEN GENERAL", productos: 2, piezas: 12, valor: 100 },
      { almacen: "CEYE", productos: 1, piezas: 3, valor: 60 },
      { almacen: SIN_ALMACEN, productos: 1, piezas: 2, valor: 0 },
    ]);
  });

  it("con `incluir` el resumen sólo cuenta esos insumos", () => {
    const { resumen } = repartirPorAlmacen(movs, lotes, new Set(["a"]));
    expect(resumen.map((r) => [r.almacen, r.piezas])).toEqual([["ALMACEN GENERAL", 8], ["CEYE", 3]]);
  });
});
