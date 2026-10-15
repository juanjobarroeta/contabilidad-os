import { describe, it, expect } from "vitest";
import { cruceCompras } from "./cruce-compras";

// ─────────────────────────────────────────────────────────────────────────────
// Nada cruzaba el anaquel con la factura: un lote sin CFDI no tenía asiento, y
// un CFDI sin recepción inflaba 115.01. Con «la recepción manda» el CFDI ya no
// escribe kardex: lo facturado sale de sus renglones ligados al catálogo.
// ─────────────────────────────────────────────────────────────────────────────

const F = (iso: string) => new Date(iso);
const INV1 = { id: "i1", serie: "F", folio: "9", uuid: null, fecha: F("2026-08-07T00:00:00Z"), customer: { razonSocial: "Farma SA" }, contraparteNombre: null };
const INV2 = { id: "i2", serie: "A", folio: "1", uuid: null, fecha: F("2026-08-08T00:00:00Z"), customer: { razonSocial: "Gasas SA" }, contraparteNombre: null };
const INV3 = { id: "i3", serie: "B", folio: "2", uuid: null, fecha: F("2026-08-09T00:00:00Z"), customer: null, contraparteNombre: "Otro SA" };

function dbFalsa(opts: { lotes?: unknown[]; derivadas?: unknown[]; renglones?: unknown[] } = {}) {
  return {
    hospLote: {
      findMany: async () =>
        opts.lotes ?? [
          {
            id: "l1", lote: "A-1", recibidoAt: F("2026-08-05T00:00:00Z"), costoUnitario: 10,
            insumo: { nombre: "Gasas" }, supplier: { razonSocial: "Proveedor SA" },
            movimientos: [{ cantidad: 20, costoUnitario: 10, solicitudPartida: null }],
          },
        ],
    },
    hospMovimientoInsumo: {
      findMany: async (args: { where: { tipo: string } }) =>
        args.where.tipo === "ENTRADA_COMPRA"
          ? opts.derivadas ?? [
              { cantidad: 5, costoUnitario: 100, invoice: INV1 },
              { cantidad: 2, costoUnitario: 50, invoice: INV1 },
            ]
          : [
              { id: "d1", fecha: F("2026-08-20T00:00:00Z"), cantidad: -3, costoUnitario: 40, referencia: "caja dañada", insumo: { nombre: "Cefalotina" }, lote: { lote: "C-7", supplier: { razonSocial: "Farma SA" } } },
            ],
    },
    hospCfdiLinea: { findMany: async () => opts.renglones ?? [] },
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

  it("la recepción manda: CFDIs sin recepción salen de sus renglones; la orden ya recibida no se reporta", async () => {
    const c = await cruceCompras(
      dbFalsa({
        derivadas: [],
        renglones: [
          { estado: "LIGADA", importe: 300, solicitudPartida: { cantidadRecibida: 0 }, invoice: INV2 },
          { estado: "POR_LIGAR", importe: 45.5, solicitudPartida: null, invoice: INV2 },
          // i3: una de sus líneas de orden ya recibió → la factura no es «sin recepción».
          { estado: "LIGADA", importe: 900, solicitudPartida: { cantidadRecibida: 10 }, invoice: INV3 },
          { estado: "LIGADA", importe: 100, solicitudPartida: { cantidadRecibida: 0 }, invoice: INV3 },
        ],
      }) as never,
      "c1",
      F("2026-08-01T00:00:00Z"),
      F("2026-09-01T00:00:00Z")
    );
    expect(c.cfdisSinRecepcion).toEqual([
      { invoiceId: "i2", referencia: "A-1", fecha: INV2.fecha, proveedor: "Gasas SA", renglones: 2, porLigar: 1, monto: 345.5 },
    ]);
  });

  it("un lote recibido contra una línea de orden cuyo renglón de CFDI está ligado no es «sin CFDI»", async () => {
    const c = await cruceCompras(
      dbFalsa({
        lotes: [
          {
            id: "l2", lote: "B-2", recibidoAt: F("2026-08-05T00:00:00Z"), costoUnitario: 10, insumo: { nombre: "Cefalotina" }, supplier: null,
            movimientos: [{ cantidad: 12, costoUnitario: 18.5, solicitudPartida: { hospCfdiLineas: [{ invoiceId: "i9" }] } }],
          },
          {
            id: "l3", lote: "B-3", recibidoAt: F("2026-08-06T00:00:00Z"), costoUnitario: 10, insumo: { nombre: "Gasas" }, supplier: null,
            movimientos: [{ cantidad: 4, costoUnitario: 10, solicitudPartida: { hospCfdiLineas: [] } }],
          },
        ],
      }) as never,
      "c1",
      F("2026-08-01T00:00:00Z"),
      F("2026-09-01T00:00:00Z")
    );
    expect(c.lotesSinCfdi.map((l) => l.loteId)).toEqual(["l3"]);
  });
});
