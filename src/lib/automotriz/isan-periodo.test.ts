import { describe, it, expect } from "vitest";
import { isanDelPeriodo } from "./isan-periodo";

// Db falso: sólo `vehiculo.findMany`, que es lo único que toca el cálculo.
const db = (filas: unknown[]) =>
  ({ vehiculo: { findMany: async () => filas } }) as never;

const unidad = (over: Record<string, unknown> = {}) => ({
  id: "v1", vin: "3N1AB8CV9SY204411", marca: "Nissan", modelo: "Sentra", anio: 2025,
  tipo: "NUEVO", precioVenta: 500_000, fechaVenta: new Date(2026, 4, 12), isan: 0,
  ...over,
});

describe("isanDelPeriodo()", () => {
  it("un seminuevo no causa ISAN y no entra al papel de trabajo", async () => {
    // Art. 1 LFISAN: el impuesto es sobre automóviles NUEVOS.
    const r = await isanDelPeriodo(db([unidad({ tipo: "SEMINUEVO" })]), "c1", 2026, 5);
    expect(r.unidades).toHaveLength(0);
    expect(r.total).toBe(0);
    expect(r.seminuevosVendidos).toBe(1);
  });

  it("separa las exentas totales de las parciales y de las que pagan completo", async () => {
    // Umbrales 2026: exención total ≤ $356,934.05; parcial ≤ $452,116.48.
    const r = await isanDelPeriodo(
      db([
        unidad({ id: "a", precioVenta: 300_000 }),
        unidad({ id: "b", precioVenta: 400_000 }),
        unidad({ id: "c", precioVenta: 900_000 }),
      ]),
      "c1", 2026, 5
    );
    expect(r.exentasTotal).toBe(1);
    expect(r.exentasParcial).toBe(1);
    expect(r.gravadasCompleto).toBe(1);
    expect(r.unidades.find((u) => u.vehiculoId === "a")!.isan).toBe(0);
  });

  it("la exenta parcial paga la mitad de la tarifa", async () => {
    const r = await isanDelPeriodo(db([unidad({ precioVenta: 400_000 })]), "c1", 2026, 5);
    const u = r.unidades[0];
    expect(u.exencion).toBe("PARCIAL");
    // Ambas cifras se redondean por separado, así que la mitad de la tarifa
    // redondeada puede diferir del ISAN redondeado en medio centavo.
    expect(Math.abs(u.isan - u.impuestoTarifa / 2)).toBeLessThanOrEqual(0.01);
  });

  it("avisa cuando hay ISAN causado que no está registrado en la unidad", async () => {
    // El caso real: la venta la reconstruyó el derivador desde el CFDI y nunca
    // pasó por vender(), así que Vehiculo.isan quedó en cero.
    const r = await isanDelPeriodo(db([unidad({ precioVenta: 900_000, isan: 0 })]), "c1", 2026, 5);
    expect(r.total).toBeGreaterThan(0);
    expect(r.totalRegistrado).toBe(0);
    expect(r.advertencias.join(" ")).toMatch(/no está registrado/i);
  });

  it("no avisa de diferencia cuando lo guardado ya coincide con lo calculado", async () => {
    const previo = await isanDelPeriodo(db([unidad({ precioVenta: 900_000 })]), "c1", 2026, 5);
    const r = await isanDelPeriodo(
      db([unidad({ precioVenta: 900_000, isan: previo.total })]), "c1", 2026, 5
    );
    expect(r.advertencias.join(" ")).not.toMatch(/no está registrado/i);
  });

  it("una unidad nueva sin precio se señala en vez de contarse como exenta", async () => {
    // Sin precio el impuesto sale $0, que se confunde con la exención del
    // Art. 8-II. Son cosas distintas: una es la ley, la otra es un dato que falta.
    const r = await isanDelPeriodo(db([unidad({ precioVenta: null })]), "c1", 2026, 5);
    expect(r.total).toBe(0);
    expect(r.advertencias.join(" ")).toMatch(/no tienen precio de venta/i);
  });

  it("sin tarifa del ejercicio no inventa el impuesto: reporta cero y lo dice", async () => {
    const r = await isanDelPeriodo(db([unidad({ precioVenta: 900_000 })]), "c1", 1999, 5);
    expect(r.total).toBe(0);
    expect(r.advertencias.join(" ")).toMatch(/No hay tarifa ISAN cargada para 1999/i);
  });
});
