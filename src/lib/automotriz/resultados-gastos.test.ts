import { describe, it, expect } from "vitest";
import { gastosDeOperacion } from "./resultados-gastos";

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
