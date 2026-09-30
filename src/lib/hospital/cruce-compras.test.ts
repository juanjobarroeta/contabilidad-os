import { describe, it, expect } from "vitest";
import { cruceCompras } from "./cruce-compras";

// ─────────────────────────────────────────────────────────────────────────────
// Sin orden de compra, nada cruzaba el anaquel con la factura: un lote sin
// CFDI no tenía asiento, y un CFDI sin recepción inflaba 115.01.
// ─────────────────────────────────────────────────────────────────────────────

const F = (iso: string) => new Date(iso);

function dbFalsa() {
  return {
    hospLote: {
      findMany: async () => [
        {
          id: "l1", lote: "A-1", recibidoAt: F("2026-08-05T00:00:00Z"), costoUnitario: 10,
          insumo: { nombre: "Gasas" }, supplier: { razonSocial: "Proveedor SA" },
          movimientos: [{ cantidad: 20, costoUnitario: 10 }],
        },
      ],
    },
    hospMovimientoInsumo: {
      findMany: async (args: { where: { tipo: string } }) =>
        args.where.tipo === "ENTRADA_COMPRA"
          ? [
              { cantidad: 5, costoUnitario: 100, invoice: { id: "i1", serie: "F", folio: "9", uuid: null, fecha: F("2026-08-07T00:00:00Z"), customer: { razonSocial: "Farma SA" }, contraparteNombre: null } },
              { cantidad: 2, costoUnitario: 50, invoice: { id: "i1", serie: "F", folio: "9", uuid: null, fecha: F("2026-08-07T00:00:00Z"), customer: { razonSocial: "Farma SA" }, contraparteNombre: null } },
            ]
          : [
              { id: "d1", fecha: F("2026-08-20T00:00:00Z"), cantidad: -3, costoUnitario: 40, referencia: "caja dañada", insumo: { nombre: "Cefalotina" }, lote: { lote: "C-7", supplier: { razonSocial: "Farma SA" } } },
            ],
    },
  };
}

describe("cruceCompras", () => {
  it("lotes sin CFDI, CFDIs sin recepción (agrupados por factura) y devoluciones al proveedor, con montos", async () => {
    const c = await cruceCompras(dbFalsa() as never, "c1", F("2026-08-01T00:00:00Z"), F("2026-09-01T00:00:00Z"));
    expect(c.lotesSinCfdi).toMatchObject([{ lote: "A-1", cantidad: 20, monto: 200, proveedor: "Proveedor SA" }]);
    expect(c.cfdisSinRecepcion).toMatchObject([{ invoiceId: "i1", referencia: "F-9", renglones: 2, monto: 600 }]);
    expect(c.devolucionesAProveedor).toMatchObject([{ cantidad: 3, monto: 120, motivo: "caja dañada" }]);
    expect(c.totales).toEqual({ lotesSinCfdi: 200, cfdisSinRecepcion: 600, devolucionesAProveedor: 120 });
  });
});
