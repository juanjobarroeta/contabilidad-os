import { describe, it, expect } from "vitest";
import { amparadoPorReps, repsPorFactura } from "./reps-amparados";

/** Sólo la tabla que el helper consulta; el filtro lo verifica el test mirando el `where`. */
function dbFalsa(filas: Array<Record<string, unknown>>) {
  const visto: { where?: Record<string, unknown> } = {};
  const db = {
    pagoDoctoRelacionado: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        visto.where = args.where;
        const lista = (args.where.parentUuid as { in: string[] }).in;
        return filas.filter((f) => lista.includes(String(f.parentUuid)));
      },
    },
  };
  return { db: db as never, visto };
}

const UUID = "3F2A1B4C-5D6E-7F80-9A0B-1C2D3E4F5061";

describe("amparadoPorReps()", () => {
  it("suma impPagado por factura, sin importar cómo venga escrito el UUID", async () => {
    const { db } = dbFalsa([
      { parentUuid: UUID.toLowerCase(), impPagado: 1000 },
      { parentUuid: UUID, impPagado: 250.5 },
      { parentUuid: "OTRO-UUID", impPagado: 999 },
    ]);
    const m = await amparadoPorReps(db, "c1", [UUID]);
    expect(m.get(UUID)).toBe(1250.5);
    expect(m.size).toBe(1);
  });

  it("pide sólo REPs vigentes de la empresa: un cancelado o sustituido no ampara nada", async () => {
    const { db, visto } = dbFalsa([]);
    await amparadoPorReps(db, "c1", [UUID]);
    expect(visto.where?.pagoInvoice).toEqual({ companyId: "c1", tipo: "PAGO", status: { not: "CANCELLED" }, sustituidoPorUuid: null });
  });

  it("sin UUIDs no consulta nada", async () => {
    const { db, visto } = dbFalsa([{ parentUuid: UUID, impPagado: 10 }]);
    expect((await amparadoPorReps(db, "c1", [null, undefined, "  "])).size).toBe(0);
    expect(visto.where).toBeUndefined();
  });
});

describe("repsPorFactura()", () => {
  // El importe que se enseña es lo que el REP ampara de ESTA factura, no su
  // total: un complemento puede amparar cinco facturas de un mismo cliente.
  it("agrupa los REPs por factura con el importe que le toca a cada una", async () => {
    const fecha = new Date("2026-09-01");
    const { db } = dbFalsa([
      { parentUuid: UUID, impPagado: 500, pagoInvoice: { id: "rep1", uuid: "U-REP-1", fecha } },
      { parentUuid: UUID.toLowerCase(), impPagado: 300, pagoInvoice: { id: "rep2", uuid: "U-REP-2", fecha } },
    ]);
    const m = await repsPorFactura(db, "c1", [UUID]);
    expect(m.get(UUID)?.map((r) => [r.id, r.total])).toEqual([
      ["rep1", 500],
      ["rep2", 300],
    ]);
  });
});

describe("notasAplicadasEnPago() — la nota que el emisor aplicó en el pago de OTRA factura", () => {
  it("el sobrante igual a la reducción que declara el REP se aplica ahí (PRONAMAC: NCC-12305 → VP-45045)", async () => {
    const { notasAplicadasEnPago } = await import("./reps-amparados");
    const r = notasAplicadasEnPago([{ notaId: "ncc-12305", monto: 376.74 }], [{ facturaId: "vp-45045", monto: 376.74 }, { facturaId: "aa-1", monto: 0 }]);
    expect([...r]).toEqual([["ncc-12305", "vp-45045"]]);
  });
  it("sin reducción exacta no inventa nada; cada reducción se usa una sola vez", async () => {
    const { notasAplicadasEnPago } = await import("./reps-amparados");
    expect(notasAplicadasEnPago([{ notaId: "n1", monto: 30.69 }], [{ facturaId: "f1", monto: 376.74 }]).size).toBe(0);
    const r = notasAplicadasEnPago([{ notaId: "n1", monto: 100 }, { notaId: "n2", monto: 100 }], [{ facturaId: "f1", monto: 100 }]);
    expect([...r]).toEqual([["n1", "f1"]]);
  });
});
