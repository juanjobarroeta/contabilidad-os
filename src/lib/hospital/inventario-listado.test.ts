import { describe, expect, it } from "vitest";
import { caducidadDe, categoriaDeClave, parseInventario, valorLeido } from "./inventario-listado";

/** Un renglón del reporte, con las celdas en las columnas que de verdad usa. */
const en = (pares: Record<number, string | number>): unknown[] => {
  const max = Math.max(...Object.keys(pares).map(Number));
  const r: unknown[] = Array(max + 1).fill(null);
  for (const [i, v] of Object.entries(pares)) r[Number(i)] = v;
  return r;
};

describe("caducidadDe", () => {
  it("toma el ÚLTIMO día del mes", () => {
    // Un medicamento de «marzo 2031» sirve todo marzo; el día 1 lo retira antes.
    expect(caducidadDe("MAR 2031")?.toISOString().slice(0, 10)).toBe("2031-03-31");
    expect(caducidadDe("FEB 2032")?.toISOString().slice(0, 10)).toBe("2032-02-29");
    expect(caducidadDe("JAN 2035")?.toISOString().slice(0, 10)).toBe("2035-01-31");
  });

  // 1,245 de los 2,183 lotes de Haltus traen DEC 2999. Guardarlo como fecha
  // pondría media farmacia a caducar en el año 2999.
  it("DEC 2999 es «no caduca», no una fecha", () => {
    expect(caducidadDe("DEC 2999")).toBeNull();
    expect(caducidadDe("JAN 2999")).toBeNull();
  });

  it("lo que no es una fecha no se inventa", () => {
    expect(caducidadDe("SIN_LOTE")).toBeNull();
    expect(caducidadDe("")).toBeNull();
    expect(caducidadDe(null)).toBeNull();
    expect(caducidadDe("XYZ 2031")).toBeNull();
    expect(caducidadDe("MAR 1800")).toBeNull();
  });
});

describe("parseInventario", () => {
  // LA RAZÓN DE SER DEL PARSER. El mismo reporte imprime el renglón de
  // artículo en columnas distintas según el largo de la clave; leer por índice
  // fijo pierde los de la segunda forma sin avisar.
  it("lee las dos formas de columna que el reporte alterna", () => {
    const { articulos } = parseInventario([
      en({ 0: "ALMACEN BODEGA" }),
      en({ 2: "CEYE016", 7: "FUNDA GENERICA", 15: 5, 19: 249.16, 24: 1245.8 }),
      en({ 9: "R5", 13: "A6", 17: "SIN_LOTE", 22: "DEC 2999", 29: 5 }),
      en({ 6: "MAT00194", 12: "MICROCLAVE", 20: 12, 25: 10, 31: 120 }),
      en({ 12: "R1", 17: "B1", 22: "2A046016", 27: "MAR 2031", 34: 12 }),
    ]);
    expect(articulos.map((a) => a.clave)).toEqual(["CEYE016", "MAT00194"]);
    expect(articulos[1].lotes[0]).toMatchObject({ lote: "2A046016", caducidad: "MAR 2031", cantidad: 12 });
  });

  it("amarra cada lote a su artículo y guarda la ubicación", () => {
    const { articulos } = parseInventario([
      en({ 0: "ALMACEN BODEGA" }),
      en({ 2: "MAT00104", 7: "MICROCLAVE 2 VIAS", 15: 30, 19: 97.01, 24: 2910.3 }),
      en({ 9: "R5", 13: "E3", 17: "14937528", 22: "APR 2031", 29: 30 }),
    ]);
    expect(articulos[0].lotes).toEqual([
      { lote: "14937528", caducidad: "APR 2031", cantidad: 30, ubicacion: "R5-E3" },
    ]);
  });

  it("separa los almacenes y los enumera", () => {
    const { articulos, almacenes } = parseInventario([
      en({ 0: "ALMACEN BODEGA" }),
      en({ 2: "MAT1", 7: "UNO", 15: 1, 19: 10, 24: 10 }),
      en({ 0: "ALMACEN CARRO ROJO QUIROFANO" }),
      en({ 2: "MAT1", 7: "UNO", 15: 2, 19: 10, 24: 20 }),
    ]);
    expect(almacenes).toEqual(["ALMACEN BODEGA", "ALMACEN CARRO ROJO QUIROFANO"]);
    // El mismo artículo en dos almacenes son DOS renglones: una caja en el
    // carro rojo de Quirófano no es stock disponible.
    expect(articulos).toHaveLength(2);
    expect(articulos.map((a) => a.almacen)).toEqual(["ALMACEN BODEGA", "ALMACEN CARRO ROJO QUIROFANO"]);
  });

  // El reporte imprime un subtotal por almacén y un gran total con la misma
  // forma: la suma de todos vale el doble del inventario.
  it("deduce el total impreso y cuadra con lo leído", () => {
    const r = parseInventario([
      en({ 0: "ALMACEN BODEGA" }),
      en({ 2: "MAT1", 7: "UNO", 15: 1, 19: 100, 24: 100 }),
      en({ 13: 1, 19: 100, 24: 100, 28: "50.00 %" }),
      en({ 0: "ALMACEN CEYE" }),
      en({ 2: "MAT2", 7: "DOS", 15: 1, 19: 300, 24: 300 }),
      en({ 13: 1, 19: 300, 24: 300, 28: "50.00 %" }),
      en({ 13: 2, 19: 200, 24: 400, 28: "100.00 %" }),
    ]);
    expect(r.totalImpreso).toBe(400);
    expect(valorLeido(r.articulos)).toBe(400);
  });

  it("los subtotales no se confunden con artículos", () => {
    const { articulos } = parseInventario([
      en({ 0: "ALMACEN BODEGA" }),
      en({ 13: 13483, 19: 27.96, 24: 376989.14, 28: "19.22 %" }),
    ]);
    expect(articulos).toHaveLength(0);
  });

  it("un lote suelto sin artículo abierto no truena ni se cuelga de otro", () => {
    const { articulos } = parseInventario([
      en({ 9: "R5", 13: "A6", 17: "L1", 22: "MAR 2031", 29: 5 }),
      en({ 0: "ALMACEN BODEGA" }),
      en({ 2: "MAT1", 7: "UNO", 15: 1, 19: 10, 24: 10 }),
    ]);
    expect(articulos).toHaveLength(1);
    expect(articulos[0].lotes).toHaveLength(0);
  });

  it("una hoja vacía devuelve vacío", () => {
    expect(parseInventario([]).articulos).toEqual([]);
    expect(parseInventario([[], [null, null]]).articulos).toEqual([]);
  });
});

describe("categoriaDeClave", () => {
  it("usa el prefijo con el que el hospital ya clasificó su catálogo", () => {
    expect(categoriaDeClave("MED00123")).toBe("MEDICAMENTO");
    expect(categoriaDeClave("MAT00104")).toBe("MATERIAL_CURACION");
    expect(categoriaDeClave("CEYE016")).toBe("MATERIAL_CURACION");
    expect(categoriaDeClave("SOL0012")).toBe("SOLUCION");
  });

  // Dejar todo en MEDICAMENTO —el default del modelo— marcaría la papelería y
  // los artículos de limpieza como medicina, y de ahí salen los controles.
  it("lo que no es insumo clínico no se marca como medicamento", () => {
    expect(categoriaDeClave("PAP0001")).toBe("OTRO");
    expect(categoriaDeClave("LIMP0023")).toBe("OTRO");
    expect(categoriaDeClave("CONS004")).toBe("OTRO");
    expect(categoriaDeClave("12345")).toBe("OTRO");
  });
});
