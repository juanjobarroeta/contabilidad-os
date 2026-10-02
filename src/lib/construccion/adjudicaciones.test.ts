import { describe, expect, it } from "vitest";
import { desgloseIva } from "./adjudicaciones";

describe("desgloseIva", () => {
  it("todo gravado al 16 %", () => {
    expect(desgloseIva([{ importe: 1000, ivaTasa: 0.16 }])).toEqual({
      subtotal: 1000,
      iva: 160,
      total: 1160,
    });
  });

  it("líneas mezcladas: material al 16 %, alimento al 0 %, nota exenta", () => {
    expect(
      desgloseIva([
        { importe: 1000, ivaTasa: 0.16 }, // cemento
        { importe: 500, ivaTasa: 0 }, // comida de cuadrilla (tasa 0 %)
        { importe: 300, ivaTasa: null }, // nota sin IVA (exento)
      ])
    ).toEqual({ subtotal: 1800, iva: 160, total: 1960 });
  });

  it("todo exento: el total es el subtotal", () => {
    expect(
      desgloseIva([
        { importe: 250.5, ivaTasa: null },
        { importe: 99.5, ivaTasa: null },
      ])
    ).toEqual({ subtotal: 350, iva: 0, total: 350 });
  });

  it("redondea el IVA por línea, como el CFDI traslada por concepto", () => {
    // 33.33 × 0.16 = 5.3328 → 5.33 por línea; ×3 = 15.99. Sobre el agregado
    // daría 99.99 × 0.16 = 15.9984 → 16.00: un centavo de diferencia contra
    // la factura que de verdad llega.
    expect(
      desgloseIva([
        { importe: 33.33, ivaTasa: 0.16 },
        { importe: 33.33, ivaTasa: 0.16 },
        { importe: 33.33, ivaTasa: 0.16 },
      ])
    ).toEqual({ subtotal: 99.99, iva: 15.99, total: 115.98 });
  });

  it("sin líneas = ceros", () => {
    expect(desgloseIva([])).toEqual({ subtotal: 0, iva: 0, total: 0 });
  });
});
