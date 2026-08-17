import { describe, expect, it } from "vitest";
import {
  aplicarRetencionLocal,
  montoRetencionLocal,
  nodoRetencionLocal,
  NOMBRE_CINCO_AL_MILLAR,
  subtotalDePartidas,
  TASA_CINCO_AL_MILLAR,
  type PartidaConProducto,
} from "./retencion-local";

const partida = (quantity: number, price: number): PartidaConProducto => ({
  quantity,
  product: { price },
});

describe("TASA_CINCO_AL_MILLAR", () => {
  it("es 5 por millar, no 5 por ciento", () => {
    expect(TASA_CINCO_AL_MILLAR).toBe(0.005);
    // $1,000,000 de estimación retienen $5,000.
    expect(montoRetencionLocal(1_000_000, TASA_CINCO_AL_MILLAR)).toBe(5_000);
  });
});

describe("subtotalDePartidas", () => {
  it("suma cantidad × precio", () => {
    expect(subtotalDePartidas([{ quantity: 2, price: 1_500 }, { quantity: 1, price: 500 }])).toBe(3_500);
  });

  it("redondea a dos decimales", () => {
    expect(subtotalDePartidas([{ quantity: 3, price: 33.333 }])).toBe(100);
  });

  it("sin partidas es cero", () => {
    expect(subtotalDePartidas([])).toBe(0);
  });
});

describe("montoRetencionLocal", () => {
  it("redondea a dos decimales", () => {
    // 12,345.67 × 0.005 = 61.72835 → 61.73
    expect(montoRetencionLocal(12_345.67, TASA_CINCO_AL_MILLAR)).toBe(61.73);
  });

  it("base o tasa no positivas no retienen nada", () => {
    expect(montoRetencionLocal(0, TASA_CINCO_AL_MILLAR)).toBe(0);
    expect(montoRetencionLocal(-100, TASA_CINCO_AL_MILLAR)).toBe(0);
    expect(montoRetencionLocal(1000, 0)).toBe(0);
  });
});

describe("nodoRetencionLocal", () => {
  it("arma el nodo con la tasa y el nombre por defecto", () => {
    expect(nodoRetencionLocal({ subtotal: 100_000 })).toEqual({
      type: NOMBRE_CINCO_AL_MILLAR,
      rate: 0.005,
      withholding: true,
      base: 100_000,
    });
  });

  it("acepta otra retención local (no todo es 5 al millar)", () => {
    const n = nodoRetencionLocal({ subtotal: 50_000, tasa: 0.02, nombre: "ISH" });
    expect(n).toMatchObject({ type: "ISH", rate: 0.02, base: 50_000 });
  });

  it("sin subtotal no hay nodo", () => {
    expect(nodoRetencionLocal({ subtotal: 0 })).toBeNull();
    expect(nodoRetencionLocal({ subtotal: -5 })).toBeNull();
  });

  it("acota el nombre y no lo deja vacío", () => {
    expect(nodoRetencionLocal({ subtotal: 100, nombre: "X".repeat(50) })!.type).toHaveLength(20);
    expect(nodoRetencionLocal({ subtotal: 100, nombre: "   " })!.type).toBe(NOMBRE_CINCO_AL_MILLAR);
  });
});

describe("aplicarRetencionLocal", () => {
  it("apagada, deja las partidas intactas", () => {
    const items = [partida(1, 1000)];
    const r = aplicarRetencionLocal(items, { activa: false });
    expect(r[0].product).not.toHaveProperty("local_taxes");
  });

  it("va CONSOLIDADA en la primera partida, no una por concepto", () => {
    // Repartirla por concepto produce varios RetencionesLocales y, con el
    // redondeo de cada uno, un total que no cuadra con el 0.5% del contrato.
    const items = [partida(1, 100_000), partida(2, 25_000), partida(1, 3_333.33)];
    const r = aplicarRetencionLocal(items, { activa: true });
    expect(r[0].product.local_taxes).toHaveLength(1);
    expect(r[1].product).not.toHaveProperty("local_taxes");
    expect(r[2].product).not.toHaveProperty("local_taxes");
  });

  it("la base es el SUBTOTAL COMPLETO, no el de la primera partida", () => {
    const items = [partida(1, 100_000), partida(2, 25_000)];
    const r = aplicarRetencionLocal(items, { activa: true });
    // 100,000 + 50,000 = 150,000 → retención 750
    expect(r[0].product.local_taxes![0].base).toBe(150_000);
    expect(montoRetencionLocal(r[0].product.local_taxes![0].base, TASA_CINCO_AL_MILLAR)).toBe(750);
  });

  it("la base NO lleva IVA: es el importe contratado", () => {
    // Sobre el total con IVA (116,000) la retención saldría 580 en vez de 500
    // — un 16% de más que nadie contrató.
    const r = aplicarRetencionLocal([partida(1, 100_000)], { activa: true });
    expect(r[0].product.local_taxes![0].base).toBe(100_000);
    expect(montoRetencionLocal(r[0].product.local_taxes![0].base, TASA_CINCO_AL_MILLAR)).toBe(500);
  });

  it("no muta las partidas de entrada", () => {
    const items = [partida(1, 1000)];
    aplicarRetencionLocal(items, { activa: true });
    expect(items[0].product).not.toHaveProperty("local_taxes");
  });

  it("conserva el resto del producto", () => {
    const items = [{ quantity: 1, product: { price: 1000, description: "Estimación 3", product_key: "72141500" } }];
    const r = aplicarRetencionLocal(items, { activa: true });
    expect(r[0].product.description).toBe("Estimación 3");
    expect(r[0].product.product_key).toBe("72141500");
  });

  it("sin partidas, o con importe cero, no rompe", () => {
    expect(aplicarRetencionLocal([], { activa: true })).toEqual([]);
    const r = aplicarRetencionLocal([partida(1, 0)], { activa: true });
    expect(r[0].product).not.toHaveProperty("local_taxes");
  });
});
