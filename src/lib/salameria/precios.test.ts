import { describe, expect, it } from "vitest";
import { costoEnvio, resolverPrecio, totalesPedido } from "./precios";

const PUBLICA = { id: "l-pub", descuento: 0, publica: true };
const MAYOREO = { id: "l-may", descuento: 0.15, publica: false };

// Lotus Topping 1kg: $499 al público, con quiebre a $460 desde 12 piezas.
const RENGLONES = [
  { listaId: "l-pub", productoId: "lotus", precio: 499, minimo: 1 },
  { listaId: "l-pub", productoId: "lotus", precio: 460, minimo: 12 },
  { listaId: "l-may", productoId: "lotus", precio: 399, minimo: 1 },
];

describe("resolverPrecio", () => {
  it("sin sesión ve el precio público", () => {
    const r = resolverPrecio({
      productoId: "lotus",
      cantidad: 1,
      renglones: RENGLONES,
      listaPublica: PUBLICA,
      listaCliente: null,
    });
    expect(r.precio).toBe(499);
    expect(r.origen).toBe("PUBLICA");
  });

  it("aplica el quiebre por volumen del público", () => {
    const r = resolverPrecio({
      productoId: "lotus",
      cantidad: 12,
      renglones: RENGLONES,
      listaPublica: PUBLICA,
      listaCliente: null,
    });
    expect(r.precio).toBe(460);
    expect(r.minimoAplicado).toBe(12);
  });

  it("por debajo del mínimo NO aplica el quiebre", () => {
    const r = resolverPrecio({
      productoId: "lotus",
      cantidad: 11,
      renglones: RENGLONES,
      listaPublica: PUBLICA,
      listaCliente: null,
    });
    expect(r.precio).toBe(499);
    expect(r.minimoAplicado).toBe(null);
  });

  it("el renglón explícito de la lista del cliente gana sobre el descuento", () => {
    const r = resolverPrecio({
      productoId: "lotus",
      cantidad: 1,
      renglones: RENGLONES,
      listaPublica: PUBLICA,
      listaCliente: MAYOREO,
    });
    // 399 negociado, no 424.15 (que sería 499 − 15 %).
    expect(r.precio).toBe(399);
    expect(r.origen).toBe("RENGLON");
    // Y sigue sabiendo el precio de lista para tachar el «antes».
    expect(r.precioLista).toBe(499);
  });

  it("sin renglón propio, la lista aplica su descuento general sobre el público", () => {
    const r = resolverPrecio({
      productoId: "maldon",
      cantidad: 1,
      renglones: [{ listaId: "l-pub", productoId: "maldon", precio: 130, minimo: 1 }],
      listaPublica: PUBLICA,
      listaCliente: MAYOREO,
    });
    expect(r.precio).toBe(110.5); // 130 − 15 %
    expect(r.origen).toBe("DESCUENTO");
  });

  it("un producto sin precio en la lista pública NO se puede vender", () => {
    const r = resolverPrecio({
      productoId: "fantasma",
      cantidad: 1,
      renglones: RENGLONES,
      listaPublica: PUBLICA,
      listaCliente: null,
    });
    expect(r.origen).toBe("SIN_PRECIO");
    expect(r.precio).toBe(0);
  });
});

describe("totalesPedido", () => {
  it("calcula el IVA POR PARTIDA, no sobre el subtotal", () => {
    // Un carrito mixto: alimento tasa 0 y un utensilio gravado. Aplicar una
    // tasa promedio al subtotal cobraría IVA sobre la comida.
    const t = totalesPedido({
      partidas: [
        { productoId: "biscoff", cantidad: 2, precio: 320, ivaTasa: 0 },
        { productoId: "espatula", cantidad: 1, precio: 200, ivaTasa: 0.16 },
      ],
    });
    expect(t.subtotal).toBe(840);
    expect(t.iva).toBe(32); // sólo la espátula
    expect(t.total).toBe(872);
  });

  it("trata el exento (null) como cero IVA", () => {
    const t = totalesPedido({
      partidas: [{ productoId: "x", cantidad: 1, precio: 100, ivaTasa: null }],
    });
    expect(t.iva).toBe(0);
    expect(t.partidas[0].ivaTasa).toBe(null); // la distinción viaja a la factura
  });

  it("el envío es un servicio: grava al 16 % aunque la mercancía sea tasa 0", () => {
    const t = totalesPedido({
      partidas: [{ productoId: "biscoff", cantidad: 1, precio: 320, ivaTasa: 0 }],
      envio: 100,
    });
    expect(t.envio).toBe(100);
    expect(t.iva).toBe(16);
    expect(t.total).toBe(436);
  });

  it("resta el descuento antes del total", () => {
    const t = totalesPedido({
      partidas: [{ productoId: "a", cantidad: 1, precio: 1000, ivaTasa: 0 }],
      descuento: 100,
    });
    expect(t.total).toBe(900);
  });
});

describe("costoEnvio", () => {
  // La regla del letrero de la tienda: «Envíos SÓLO $100 en compras de $3,000+».
  const REGLA = { umbral: 3000, tarifa: 100, tarifaBase: 250 };

  it("cobra la tarifa preferente al alcanzar el umbral", () => {
    expect(costoEnvio({ ...REGLA, subtotal: 3000 })).toBe(100);
    expect(costoEnvio({ ...REGLA, subtotal: 5000 })).toBe(100);
  });

  it("cobra la tarifa normal por debajo del umbral", () => {
    expect(costoEnvio({ ...REGLA, subtotal: 2999 })).toBe(250);
  });

  it("recoger en tienda no cobra envío", () => {
    expect(costoEnvio({ ...REGLA, subtotal: 100, recogeEnTienda: true })).toBe(0);
  });
});
