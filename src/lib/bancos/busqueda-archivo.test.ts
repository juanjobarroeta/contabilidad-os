import { describe, it, expect } from "vitest";
import { filtroBusquedaArchivo, importeBuscado, mesesDelSelector } from "./busqueda-archivo";

describe("importeBuscado", () => {
  it("acepta el importe tal como se copia del estado de cuenta", () => {
    expect(importeBuscado("17400")).toBe(17400);
    expect(importeBuscado("17,400.50")).toBe(17400.5);
    expect(importeBuscado("$ 17,400.50")).toBe(17400.5);
  });

  it("el signo no importa: se busca el cargo Y el abono", () => {
    expect(importeBuscado("-17400")).toBe(17400);
  });

  it("lo que no es un importe no lo es", () => {
    // Sin esto, `Number("")` = 0 y `Number("PEMEX")` = NaN se colarían como
    // monto y toda búsqueda de texto arrastraría un filtro de importe.
    expect(importeBuscado("")).toBeNull();
    expect(importeBuscado("PEMEX")).toBeNull();
    expect(importeBuscado("-")).toBeNull();
    expect(importeBuscado("17400 PEMEX")).toBeNull();
    // Cero no es un importe que alguien busque, y casaría con los renglones
    // en ceros de las comisiones exentas.
    expect(importeBuscado("0")).toBeNull();
    expect(importeBuscado("0.00")).toBeNull();
  });
});

describe("filtroBusquedaArchivo", () => {
  it("sin texto no filtra nada", () => {
    expect(filtroBusquedaArchivo("")).toBeNull();
    expect(filtroBusquedaArchivo("   ")).toBeNull();
  });

  it("busca en concepto, contraparte, RFC y referencia, sin distinguir mayúsculas", () => {
    const f = filtroBusquedaArchivo("pemex");
    const campos = (f?.OR as Record<string, unknown>[]).map((c) => Object.keys(c)[0]);
    expect(campos).toEqual(["descripcion", "contraparteNombre", "contraparteRfc", "referencia"]);
    expect(f?.OR?.[0]).toEqual({ descripcion: { contains: "pemex", mode: "insensitive" } });
  });

  it("un importe agrega el monto exacto en los dos signos", () => {
    const f = filtroBusquedaArchivo("17,400");
    expect(f?.OR).toHaveLength(5);
    expect(f?.OR?.[4]).toEqual({ monto: { in: [17400, -17400] } });
  });

  it("un texto que no es importe no agrega filtro de monto", () => {
    expect(filtroBusquedaArchivo("PEMEX")?.OR).toHaveLength(4);
  });
});

describe("mesesDelSelector", () => {
  it("pasa el agregado de Postgres tal cual (bigint → number)", () => {
    expect(mesesDelSelector([{ mes: "2026-08", n: BigInt(12) }, { mes: "2026-07", n: BigInt(3) }])).toEqual([
      { mes: "2026-08", count: 12 },
      { mes: "2026-07", count: 3 },
    ]);
  });

  it("agrupa fechas por mes UTC, del más reciente al más viejo", () => {
    expect(
      mesesDelSelector([
        { fecha: new Date("2026-07-15T00:00:00Z") },
        { fecha: new Date("2026-08-02T00:00:00Z") },
        { fecha: new Date("2026-07-31T23:59:59Z") },
      ]),
    ).toEqual([
      { mes: "2026-08", count: 1 },
      { mes: "2026-07", count: 2 },
    ]);
  });

  it("el corte es el MISMO que el del filtro `mes` (UTC), no el local", () => {
    // 1-ago 00:30 UTC es 31-jul en hora de México. El filtro del handler corta
    // con Date.UTC, así que este renglón pertenece a agosto en los dos lados:
    // agruparlo en julio dejaría el conteo del selector sin cuadrar con la
    // lista que sale al elegir el mes.
    expect(mesesDelSelector([{ fecha: new Date("2026-08-01T00:30:00Z") }])).toEqual([
      { mes: "2026-08", count: 1 },
    ]);
  });

  it("sin filas, sin meses", () => {
    expect(mesesDelSelector([])).toEqual([]);
  });
});
