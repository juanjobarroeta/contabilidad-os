import { describe, expect, it } from "vitest";
import { prorratearImportacion } from "./costeo";

/**
 * El caso real que este módulo existe para resolver: un contenedor de La
 * Salamería con dos productos de peso y valor muy distintos. Si el flete se
 * repartiera por valor, la cubeta de 8 kg (barata y pesada) pagaría de menos y
 * el praliné de pistache (caro y ligero) pagaría de más — y el precio de venta
 * de los dos saldría mal.
 */
const ITEMS = [
  // 100 cubetas Lotus de 8 kg a 120 USD
  { id: "lotus", cantidad: 100, precioMoneda: 120, pesoKg: 8 },
  // 50 pralinés de pistache de 1 kg a 90 USD
  { id: "praline", cantidad: 50, precioMoneda: 90, pesoKg: 1 },
];

const TC = 20;

describe("prorratearImportacion", () => {
  it("convierte a pesos con el tipo de cambio del pedimento", () => {
    const r = prorratearImportacion({ items: ITEMS, costos: [], tipoCambio: TC });
    expect(r.items[0].valorMxn).toBe(240_000); // 100 × 120 × 20
    expect(r.items[1].valorMxn).toBe(90_000); //  50 ×  90 × 20
    expect(r.valorMercancia).toBe(330_000);
    expect(r.costoMercancia).toBe(330_000);
  });

  it("reparte el flete por PESO, no por valor", () => {
    // 850 kg en total (800 de Lotus, 50 de praliné). Flete de $85,000 → $100/kg.
    const r = prorratearImportacion({
      items: ITEMS,
      costos: [
        { tipo: "FLETE_INTERNACIONAL", importe: 85_000, prorratea: true, base: "PESO" },
      ],
      tipoCambio: TC,
    });
    expect(r.items[0].prorrateo).toBe(80_000); // 800 kg
    expect(r.items[1].prorrateo).toBe(5_000); //   50 kg
    // Por valor le habría tocado ~$61,800 al lotus y ~$23,200 al praliné:
    // cuatro veces más flete del que realmente ocupa en el contenedor.
    expect(r.items[1].prorrateo).toBeLessThan(23_000);
  });

  it("reparte el arancel por VALOR", () => {
    const r = prorratearImportacion({
      items: ITEMS,
      costos: [{ tipo: "ARANCEL", importe: 33_000, prorratea: true, base: "VALOR" }],
      tipoCambio: TC,
    });
    // 240/330 y 90/330 del arancel.
    expect(r.items[0].prorrateo).toBe(24_000);
    expect(r.items[1].prorrateo).toBe(9_000);
  });

  it("NO mete el IVA de importación al costo — es acreditable", () => {
    const r = prorratearImportacion({
      items: ITEMS,
      costos: [
        { tipo: "FLETE_INTERNACIONAL", importe: 85_000, prorratea: true, base: "PESO" },
        { tipo: "IVA_IMPORTACION", importe: 66_400, prorratea: false, base: "VALOR" },
      ],
      tipoCambio: TC,
    });
    expect(r.ivaImportacion).toBe(66_400);
    // El almacén se carga con mercancía + flete, sin un centavo del IVA.
    expect(r.costoMercancia).toBe(415_000); // 330,000 + 85,000
    expect(r.items[0].costoTotal + r.items[1].costoTotal).toBe(415_000);
  });

  it("el costo unitario es el que se guarda en el lote", () => {
    const r = prorratearImportacion({
      items: ITEMS,
      costos: [
        { tipo: "FLETE_INTERNACIONAL", importe: 85_000, prorratea: true, base: "PESO" },
        { tipo: "AGENTE_ADUANAL", importe: 16_500, prorratea: true, base: "VALOR" },
      ],
      tipoCambio: TC,
    });
    // Lotus: (240,000 + 80,000 + 12,000) / 100
    expect(r.items[0].costoUnitario).toBe(3_320);
    // Praliné: (90,000 + 5,000 + 4,500) / 50
    expect(r.items[1].costoUnitario).toBe(1_990);
  });

  it("la suma de los repartos cuadra al centavo con el importe", () => {
    // Un importe que no divide exacto entre tres partidas: 1/3 de 100.
    const items = [
      { id: "a", cantidad: 1, precioMoneda: 1, pesoKg: 1 },
      { id: "b", cantidad: 1, precioMoneda: 1, pesoKg: 1 },
      { id: "c", cantidad: 1, precioMoneda: 1, pesoKg: 1 },
    ];
    const r = prorratearImportacion({
      items,
      costos: [{ tipo: "DTA", importe: 100, prorratea: true, base: "VALOR" }],
      tipoCambio: 1,
    });
    const suma = r.items.reduce((a, i) => a + i.prorrateo, 0);
    // Sin el ajuste del residuo esto daría 99.999999 y el asiento contable no
    // cuadraría con la suma de los lotes.
    expect(suma).toBe(100);
    expect(r.costosProrrateados).toBe(100);
  });

  it("avisa qué partidas no tienen peso cuando hay flete por PESO", () => {
    const r = prorratearImportacion({
      items: [
        { id: "con-peso", cantidad: 10, precioMoneda: 10, pesoKg: 2 },
        { id: "sin-peso", cantidad: 10, precioMoneda: 10, pesoKg: 0 },
      ],
      costos: [
        { tipo: "FLETE_INTERNACIONAL", importe: 1_000, prorratea: true, base: "PESO" },
      ],
      tipoCambio: 1,
    });
    expect(r.sinPeso).toEqual(["sin-peso"]);
    // Y el que sí tiene peso absorbe todo el flete: el dato falta, no se inventa.
    expect(r.items[0].prorrateo).toBe(1_000);
    expect(r.items[1].prorrateo).toBe(0);
  });

  it("sin base sobre la que repartir, parte en partes iguales en vez de perder el costo", () => {
    const r = prorratearImportacion({
      items: [
        { id: "a", cantidad: 1, precioMoneda: 0, pesoKg: 0 },
        { id: "b", cantidad: 1, precioMoneda: 0, pesoKg: 0 },
      ],
      costos: [{ tipo: "MANIOBRAS", importe: 500, prorratea: true, base: "VALOR" }],
      tipoCambio: 1,
    });
    expect(r.items[0].prorrateo).toBe(250);
    expect(r.items[1].prorrateo).toBe(250);
    expect(r.costosProrrateados).toBe(500);
  });

  it("reporta los costos no prorrateados que no son IVA en vez de tragárselos", () => {
    const r = prorratearImportacion({
      items: ITEMS,
      costos: [{ tipo: "OTRO", importe: 1_234, prorratea: false, base: "VALOR" }],
      tipoCambio: TC,
    });
    expect(r.noAplicados).toBe(1_234);
    expect(r.ivaImportacion).toBe(0);
    expect(r.costoMercancia).toBe(330_000);
  });

  it("una partida con cantidad cero da costo unitario 0, no NaN", () => {
    const r = prorratearImportacion({
      items: [{ id: "vacia", cantidad: 0, precioMoneda: 100, pesoKg: 1 }],
      costos: [],
      tipoCambio: TC,
    });
    expect(r.items[0].costoUnitario).toBe(0);
    expect(Number.isNaN(r.items[0].costoUnitario)).toBe(false);
  });
});
