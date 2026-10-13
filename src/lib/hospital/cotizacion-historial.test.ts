import { describe, expect, it } from "vitest";
import { compararCotizacion, lineasDeJson, totalLineas, type LineaHistoria } from "./cotizacion-historial";

const l = (descripcion: string, cantidad: number, precioUnitario: number, extra: Partial<LineaHistoria> = {}): LineaHistoria => ({
  servicioId: null, categoria: "PROCEDIMIENTO", descripcion, cantidad, precioUnitario, ivaTasa: 0.16, ...extra,
});

describe("compararCotizacion()", () => {
  const origen = [
    l("Quirófano 1 hora", 2, 5000, { servicioId: "s-quir", categoria: "QUIROFANO" }),
    l("Habitación estándar", 1, 3000, { servicioId: "s-hab", categoria: "HABITACION" }),
    l("Material de curación", 1, 1000, { categoria: "MATERIAL" }),
    l("Medicamentos", 1, 500, { categoria: "FARMACIA", ivaTasa: 0 }),
  ];
  // 2×5000×1.16 + 3000×1.16 + 1000×1.16 + 500 = 11,600 + 3,480 + 1,160 + 500 = 16,740
  it("sin cambios: descuento 0 y todo IGUAL", () => {
    const c = compararCotizacion({ lineas: origen, total: totalLineas(origen) }, { lineas: origen, total: totalLineas(origen) });
    expect(c.descuento).toBe(0);
    expect(c.lineas.every((x) => x.tipo === "IGUAL")).toBe(true);
  });

  it("dice cuánto se quitó y dónde: en blanco, cantidad, precio, agregado; las piezas suman el descuento", () => {
    const cotizado = [
      l("Quirófano 1 hora", 1, 5000, { servicioId: "s-quir", categoria: "QUIROFANO" }), // −1 hora: 5,800
      l("Habitación estándar", 1, 2500, { servicioId: "s-hab", categoria: "HABITACION" }), // −500 de precio: 580
      l("Material de curación", 1, 1000, { categoria: "MATERIAL", sinCotizar: true }), // en blanco: 1,160
      // medicamentos quitados: 500
      l("Ultrasonido", 1, 800, { categoria: "ESTUDIO" }), // agregado: −928
    ];
    const c = compararCotizacion({ lineas: origen, total: totalLineas(origen) }, { lineas: cotizado, total: totalLineas(cotizado) });
    expect(c.totalOriginal).toBe(16740);
    expect(c.totalCotizado).toBe(5800 + 2900 + 0 + 928);
    expect(c.porTipo).toEqual({ quitado: 1660, cantidad: 5800, precio: 580, agregado: -928, ajustePaquete: 0 });
    expect(c.porTipo.quitado + c.porTipo.cantidad + c.porTipo.precio + c.porTipo.agregado + c.porTipo.ajustePaquete).toBeCloseTo(c.descuento, 2);
    expect(c.lineas.map((x) => [x.descripcion, x.tipo])).toEqual([
      ["Quirófano 1 hora", "CANTIDAD"],
      ["Habitación estándar", "PRECIO"],
      ["Material de curación", "NO_COTIZADA"],
      ["Medicamentos", "QUITADA"],
      ["Ultrasonido", "AGREGADA"],
    ]);
    expect(c.porCategoria).toEqual({ QUIROFANO: 5800, HABITACION: 580, MATERIAL: 1160, FARMACIA: 500, ESTUDIO: -928 });
    expect(c.descuentoPct).toBeCloseTo((c.descuento / 16740) * 100, 2);
  });

  it("paquete: lo que el total pactado movió por encima de las líneas va a «ajuste del paquete»", () => {
    // El protocolo vale 23,000 en paquete; se cotizó a 20,000 sin tocar líneas.
    const c = compararCotizacion({ lineas: origen, total: 23000 }, { lineas: origen, total: 20000 });
    expect(c.descuento).toBe(3000);
    expect(c.porTipo).toEqual({ quitado: 0, cantidad: 0, precio: 0, agregado: 0, ajustePaquete: 3000 });
  });

  it("cantidad y precio a la vez: la cantidad se mide al precio de antes y el resto es precio", () => {
    const a = [l("Quirófano", 2, 5000)];
    const d = [l("Quirófano", 1, 4000)];
    const c = compararCotizacion({ lineas: a, total: totalLineas(a) }, { lineas: d, total: totalLineas(d) });
    expect(c.lineas[0].tipo).toBe("CANTIDAD_Y_PRECIO");
    expect(c.porTipo.cantidad).toBe(5800);
    expect(c.porTipo.precio).toBe(1160);
  });

  it("repetidas se emparejan en orden; sin servicio, por categoría + descripción (sin acentos ni mayúsculas)", () => {
    const a = [l("Gasas", 1, 10), l("Gasas", 2, 10)];
    const d = [l("gásas", 1, 10)];
    const c = compararCotizacion({ lineas: a, total: totalLineas(a) }, { lineas: d, total: totalLineas(d) });
    expect(c.lineas.map((x) => x.tipo)).toEqual(["IGUAL", "QUITADA"]);
  });

  it("lineasDeJson tolera basura", () => {
    expect(lineasDeJson(null)).toEqual([]);
    expect(lineasDeJson([{ descripcion: "x", cantidad: "2", precioUnitario: "3.5" }])[0]).toMatchObject({ cantidad: 2, precioUnitario: 3.5, ivaTasa: null, categoria: "OTRO" });
  });
});
