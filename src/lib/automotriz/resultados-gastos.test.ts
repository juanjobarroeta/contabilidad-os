import { describe, it, expect } from "vitest";
import { gastosDeOperacion } from "./resultados-gastos";
import { classifyEgreso } from "@/lib/contabilidad/classify-egreso";
import { COE_CODES } from "@/lib/contabilidad/catalog";

const cfdi = (claves: Array<[string, number]>) =>
  `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4"><cfdi:Conceptos>${claves
    .map(([c, imp]) => `<cfdi:Concepto ClaveProdServ="${c}" Importe="${imp.toFixed(2)}"/>`)
    .join("")}</cfdi:Conceptos></cfdi:Comprobante>`;

function fakeDb(filas: Array<{ id: string; subtotal: number; tipoSat?: string; rawXml?: string | null }>) {
  return {
    invoice: {
      findMany: async () => filas.map((f) => ({ tipoSat: "I", rawXml: null, ...f })),
    },
  } as never;
}

const D = new Date("2026-01-01");
const H = new Date("2027-01-01");

describe("gastosDeOperacion()", () => {
  it("agrupa por cuenta del catálogo COE, no por CFDI suelto", async () => {
    const db = fakeDb([
      { id: "a", subtotal: 30000, rawXml: cfdi([["80131502", 30000]]) }, // arrendamiento
      { id: "b", subtotal: 18000, rawXml: cfdi([["80131502", 18000]]) },
      { id: "c", subtotal: 5000, rawXml: cfdi([["83101801", 5000]]) }, // energía eléctrica
    ]);
    const g = await gastosDeOperacion(db, "c1", D, H);
    expect(g.total).toBe(53000);
    expect(g.lineas).toHaveLength(2);
    // Ordenado de mayor a menor: el arrendamiento manda.
    expect(g.lineas[0]).toMatchObject({ monto: 48000, facturas: 2 });
    expect(g.lineas[1].monto).toBe(5000);
  });

  it("una nota de crédito RECIBIDA resta del gasto", async () => {
    const db = fakeDb([
      { id: "a", subtotal: 30000, rawXml: cfdi([["80131502", 30000]]) },
      { id: "nc", subtotal: 10000, tipoSat: "E", rawXml: cfdi([["80131502", 10000]]) },
    ]);
    const g = await gastosDeOperacion(db, "c1", D, H);
    expect(g.total).toBe(20000);
    expect(g.lineas[0].monto).toBe(20000);
  });

  it("un CFDI sin XML no se inventa una cuenta: se reporta sin clasificar", async () => {
    const db = fakeDb([
      { id: "a", subtotal: 1000, rawXml: cfdi([["80131502", 1000]]) },
      { id: "b", subtotal: 7000, rawXml: null },
    ]);
    const g = await gastosDeOperacion(db, "c1", D, H);
    expect(g.sinClasificar).toEqual({ facturas: 1, monto: 7000 });
    // Sigue contando en el total — omitirlo subestimaría el gasto del periodo.
    expect(g.total).toBe(8000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anticipos: el 47% de «Otros gastos» de Margom ($72,165,217 en 406 facturas),
// casi todo anticipos a Yutong por camiones que todavía no llegan. Con ellos
// dentro, la agencia reportaba $77M de pérdida de operación teniendo utilidad.
// ─────────────────────────────────────────────────────────────────────────────
describe("gastosDeOperacion() — el anticipo no es gasto", () => {
  const cfdi = (clave: string, importe: number, tipoSat = "I") => ({
    id: `i-${clave}-${importe}`,
    subtotal: importe,
    tipoSat,
    rawXml: `<cfdi:Comprobante><cfdi:Conceptos><cfdi:Concepto ClaveProdServ="${clave}" Importe="${importe}"/></cfdi:Conceptos></cfdi:Comprobante>`,
  });

  const correr = async (facturas: ReturnType<typeof cfdi>[]) => {
    const db = { invoice: { findMany: async () => facturas } } as never;
    return gastosDeOperacion(db, "c1", new Date("2026-01-01"), new Date("2027-01-01"));
  };

  it("el anticipo se reporta aparte y NO entra al total del gasto", async () => {
    const r = await correr([
      cfdi("84111506", 56_034_483), // anticipo camiones Yutong
      cfdi("81112501", 100_000),    // gasto real (servicios de TI)
    ]);
    expect(r.anticipos.facturas).toBe(1);
    expect(r.anticipos.monto).toBe(56_034_483);
    // El total del gasto es SÓLO el gasto real.
    expect(r.total).toBe(100_000);
    expect(r.lineas.some((l) => l.monto === 56_034_483)).toBe(false);
  });

  it("la aplicación del anticipo (nota de crédito) también sale del gasto", async () => {
    // Si el anticipo se excluye pero su aplicación no, el gasto queda NEGATIVO.
    const r = await correr([
      cfdi("84111506", 27_879_310),
      cfdi("84111506", 27_879_310, "E"),
    ]);
    expect(r.total).toBe(0);
    expect(r.anticipos.monto).toBe(0);
    expect(r.anticipos.facturas).toBe(2);
  });

  it("una factura mixta sigue siendo gasto por lo que realmente ampara", async () => {
    // El anticipo se decide por el concepto DOMINANTE: una línea chica de
    // anticipo dentro de una factura de renta no la vuelve anticipo.
    const mixta = {
      id: "mix",
      subtotal: 500_000,
      tipoSat: "I",
      rawXml:
        `<cfdi:Concepto ClaveProdServ="80131500" Importe="480000"/>` +
        `<cfdi:Concepto ClaveProdServ="84111506" Importe="20000"/>`,
    };
    const r = await correr([mixta]);
    expect(r.anticipos.facturas).toBe(0);
    expect(r.total).toBe(500_000);
  });
});

describe("classifyEgreso() — 8013 es inmobiliario, no notarías", () => {
  it("el arrendamiento se clasifica como renta", () => {
    // $17M de renta aparecían como «Servicios notariales»: un renglón que nadie
    // cuestiona porque suena plausible. Las notarías son 80121.
    expect(classifyEgreso("80131500").label).toBe("Arrendamiento");
    expect(classifyEgreso("80131502").label).toBe("Arrendamiento");
    expect(classifyEgreso("80121500").label).toBe("Honorarios legales");
  });

  it("las familias que caían en «Otros gastos» ya tienen nombre", () => {
    for (const clave of ["82101500", "80151504", "72102900", "85101701", "84121500"]) {
      expect(classifyEgreso(clave).cuenta).not.toBe(COE_CODES.OTROS_GASTOS);
    }
  });
});

describe("gastosDeOperacion() — el ISAN es impuesto, no gasto", () => {
  const conIsan = (clave: string, descripcion: string, importe: number) => ({
    id: `i-${descripcion}`,
    subtotal: importe,
    tipoSat: "I",
    rawXml: `<cfdi:Concepto ClaveProdServ="${clave}" Descripcion="${descripcion}" Importe="${importe}"/>`,
  });

  const correr = async (facturas: ReturnType<typeof conIsan>[]) => {
    const db = { invoice: { findMany: async () => facturas } } as never;
    return gastosDeOperacion(db, "c1", new Date("2026-01-01"), new Date("2027-01-01"));
  };

  it("el ISAN sale del gasto y se reporta aparte", async () => {
    // El distribuidor lo cobra al comprador y lo entera: no compra nada. En
    // Margom hundía la utilidad de operación ~$14.8M al año.
    const r = await correr([
      conIsan("93161700", "P.PROV. I.S.A.N. FABRIC.NAC. FRANJA FRONT.", 5_475_045),
      conIsan("93161700", "DEL ISAN PAGOS PROVISIONALES", 4_427_457),
      conIsan("81112501", "Exchange Online", 100_000),
    ]);
    expect(r.isan.facturas).toBe(2);
    expect(r.isan.monto).toBe(9_902_502);
    expect(r.total).toBe(100_000);
  });

  it("otros pagos bajo la misma clave SÍ siguen siendo gasto", async () => {
    // 93161700 es «administración de impuestos» y la usan para más cosas: el
    // texto es lo que distingue al ISAN.
    const r = await correr([conIsan("93161700", "DERECHOS DE AGUA POTABLE", 524_119)]);
    expect(r.isan.facturas).toBe(0);
    expect(r.total).toBe(524_119);
  });
});
