import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { cotizacionesDe, elegirGanadoras } from "./requisiciones";

const partidas = [{ descripcion: "Jeringa" }, { descripcion: "Gasa" }, { descripcion: "Venda" }];

describe("ganadora por línea entre varias cotizaciones", () => {
  it("la más barata de las que cotizaron; en empate, la primera", () => {
    const cots = [{ precios: [3, 10, null] }, { precios: [4, 8, 25] }, { precios: [3, 9, null] }];
    expect(elegirGanadoras(partidas, cots)).toEqual([0, 1, 1]);
  });
  it("respeta la elegida si tiene precio para esa línea", () => {
    const cots = [{ precios: [3, 10, null] }, { precios: [4, 8, 25] }];
    expect(elegirGanadoras(partidas, cots, [1, null, null])).toEqual([1, 1, 1]);
    expect(() => elegirGanadoras(partidas, cots, [null, null, 0])).toThrow(/no tiene precio/);
  });
  it("una línea que nadie cotizó no pasa", () => {
    expect(() => elegirGanadoras(partidas, [{ precios: [1, 1, null] }])).toThrow(/Venda.*ningún proveedor/);
  });
  it("requisición de un solo proveedor = una cotización con los precios de las partidas", () => {
    expect(cotizacionesDe({ supplierId: "p1", partidas: [{ descripcion: "x", cantidad: 1, precioUnitario: 7 }] })).toEqual([{ supplierId: "p1", precios: [7] }]);
    expect(() => cotizacionesDe({ partidas: [] })).toThrow(/proveedor/);
  });
});
