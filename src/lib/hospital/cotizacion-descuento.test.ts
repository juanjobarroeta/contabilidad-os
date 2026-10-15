import { describe, expect, it } from "vitest";
import { aPaquete, armarPartidas, precioConDescuento } from "./cotizacion";

const servicio = { id: "s1", companyId: "c", nombre: "Habitación estándar", categoria: "HABITACION", precioLista: 2000, ivaTasa: 0.16, tarifas: [] };
const db = {
  hospServicio: { findMany: async () => [servicio] },
  hospConfig: { findUnique: async () => null },
} as never;

describe("descuento por partida", () => {
  it("baja el precio unitario al neto y guarda el % y el precio de antes", async () => {
    const r = await armarPartidas(db, "c", null, [{ servicioId: "s1", cantidad: 2, descuentoPct: 10 }]);
    expect(r.partidas[0]).toMatchObject({ precioUnitario: 1800, importe: 3600, descuentoPct: 10, precioSinDescuento: 2000 });
    expect(r.subtotal).toBe(3600);
    expect(r.total).toBe(4176);
  });
  it("sin descuento no agrega campos (planes y protocolos los crean tal cual)", async () => {
    const r = await armarPartidas(db, "c", null, [{ servicioId: "s1", cantidad: 1, precioUnitario: 1500, descuentoPct: 0 }]);
    expect(r.partidas[0].precioUnitario).toBe(1500);
    expect(r.partidas[0]).not.toHaveProperty("descuentoPct");
  });
  it("no cotizado ignora el descuento", async () => {
    const r = await armarPartidas(db, "c", null, [{ servicioId: "s1", cantidad: 1, sinCotizar: true, descuentoPct: 50 }]);
    expect(r.partidas[0]).toMatchObject({ precioUnitario: 0, importe: 0 });
    expect(r.partidas[0]).not.toHaveProperty("descuentoPct");
  });
  it("en paquete el total pactado manda y el descuento se quita", async () => {
    const lista = await armarPartidas(db, "c", null, [{ servicioId: "s1", cantidad: 1, descuentoPct: 25 }]);
    const r = aPaquete(lista, 1160);
    expect(r.partidas[0]).not.toHaveProperty("descuentoPct");
    expect(r.partidas[0]).not.toHaveProperty("precioSinDescuento");
  });
  it("precioConDescuento a 6 decimales", () => {
    expect(precioConDescuento(333.33, 7.5)).toBe(308.330250);
    expect(precioConDescuento(100, null)).toBe(100);
  });
});

describe("precios movidos (sólo COTIZACION_PRECIOS)", () => {
  it("tarifario tal cual no cuenta; capturado distinto, sin servicio o con descuento sí", async () => {
    const r = await armarPartidas(db, "c", null, [
      { servicioId: "s1", cantidad: 1 },
      { servicioId: "s1", cantidad: 1, precioUnitario: 2000 },
      { servicioId: "s1", cantidad: 1, precioUnitario: 1900 },
      { servicioId: "s1", cantidad: 1, descuentoPct: 5 },
      { categoria: "OTRO", descripcion: "Libre", cantidad: 1, precioUnitario: 300 },
      { categoria: "OTRO", descripcion: "Mencionado", cantidad: 1, sinCotizar: true },
      { categoria: "OTRO", descripcion: "Libre en cero", cantidad: 1, precioUnitario: 0 },
    ]);
    expect(r.preciosMovidos).toEqual([3, 4, 5]);
  });
});
