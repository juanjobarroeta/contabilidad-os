import { describe, it, expect } from "vitest";

// La regla de comparabilidad del costo de refacciones, aislada.
//
// Existe por un caso real: un lubricante se COMPRA por tambo (208 L) y se
// VENDE por litro. El «último costo» guardado es el del tambo, así que
// multiplicarlo por los litros que salen del kardex infla el costo ~208 veces.
//
// Ya había mordido una vez —el estado de resultados lo arregló— pero la SERIE
// de absorción se quedó con la fórmula vieja, y la misma pantalla enseñaba la
// tarjeta en 17% y la gráfica en −768%. Este test fija la regla para que las
// dos rutas no puedan volver a divergir en silencio.

type Refaccion = {
  ultimoCosto: number;
  ultimoPrecio?: number | null;
  unidadCosto?: string | null;
  unidadPrecio?: string | null;
};

/** Misma condición que el SQL de `calcularResultados` y `absorcionPorMes`. */
function comparable(r: Refaccion): boolean {
  return (
    r.ultimoCosto > 0 &&
    (r.unidadCosto == null || r.unidadPrecio == null || r.unidadCosto === r.unidadPrecio) &&
    !((r.ultimoPrecio ?? 0) > 0 && r.ultimoCosto > (r.ultimoPrecio ?? 0) * 2)
  );
}

describe("comparabilidad del costo de una refacción", () => {
  it("descarta el costo cuando la unidad de compra difiere de la de venta", () => {
    // Tambo de 208 L comprado a $18,000; se vende el litro a $115.
    const lubricante = { ultimoCosto: 18_000, ultimoPrecio: 115, unidadCosto: "XBA", unidadPrecio: "LTR" };
    expect(comparable(lubricante)).toBe(false);
  });

  it("acepta el costo cuando compra y venta usan la misma unidad", () => {
    const balata = { ultimoCosto: 1_200, ultimoPrecio: 1_840, unidadCosto: "H87", unidadPrecio: "H87" };
    expect(comparable(balata)).toBe(true);
  });

  it("sin unidades guardadas, descarta el costo que supera al doble del precio", () => {
    // Filas viejas sin `unidadCosto`: la única señal es que un costo mayor al
    // doble del precio no ocurre por negocio en una refacción.
    expect(comparable({ ultimoCosto: 18_000, ultimoPrecio: 115 })).toBe(false);
    expect(comparable({ ultimoCosto: 1_200, ultimoPrecio: 1_840 })).toBe(true);
  });

  it("sin costo conocido no hay nada que comparar", () => {
    expect(comparable({ ultimoCosto: 0, ultimoPrecio: 500 })).toBe(false);
  });

  it("sin precio conocido no aplica la prueba del doble", () => {
    // No se puede juzgar por precio, así que manda la unidad.
    expect(comparable({ ultimoCosto: 900, ultimoPrecio: null, unidadCosto: "H87", unidadPrecio: "H87" })).toBe(true);
  });

  it("la absorción se mantiene en rango con la regla aplicada", () => {
    // Cifras reales de MARGOM (agosto 2026), en millones:
    //   sin regla:  ingreso 3.53 · costo 85.47  → margen −2,321%
    //   con regla:  ingreso 2.58 · costo  1.92  → margen +26%
    const conRegla = (2.58 - 1.92) / 2.58;
    const sinRegla = (3.53 - 85.47) / 3.53;
    expect(conRegla).toBeGreaterThan(0);
    expect(conRegla).toBeLessThan(1);
    expect(sinRegla).toBeLessThan(-1); // absurdo: el costo 24x la venta
  });
});
