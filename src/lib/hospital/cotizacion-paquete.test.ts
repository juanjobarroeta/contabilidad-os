import { describe, expect, it } from "vitest";
import { aPaquete, type PartidaArmada } from "./cotizacion";

const partida = (importe: number, ivaTasa: number | null, cantidad = 1): PartidaArmada => ({
  orden: 0, servicioId: null, categoria: "QUIROFANO", descripcion: "x", cantidad, precioUnitario: importe / cantidad, ivaTasa, importe,
});

describe("aPaquete", () => {
  it("prorratea las partidas al total con IVA pactado, centavo exacto", () => {
    const partidas = [partida(9000, 0.16, 3), partida(300, 0, 3), partida(2000, 0.16)];
    const lista = { partidas, subtotal: 11300, iva: 1760, total: 13060 };
    const r = aPaquete(lista, 23000);
    expect(r.total).toBe(23000);
    const recalculado = r.partidas.reduce((s, p) => s + p.importe + (p.ivaTasa ? Math.round(p.importe * p.ivaTasa * 100) / 100 : 0), 0);
    expect(Math.abs(recalculado - 23000)).toBeLessThan(0.02);
    expect(r.subtotal + r.iva).toBeCloseTo(23000, 2);
    // Mismo peso relativo que a precio de lista.
    expect(r.partidas[0].importe / r.partidas[2].importe).toBeCloseTo(4.5, 1);
  });

  it("rechaza un paquete sin partidas con precio", () => {
    expect(() => aPaquete({ partidas: [partida(0, null)], subtotal: 0, iva: 0, total: 0 }, 1000)).toThrow(/al menos una partida/);
  });
});
