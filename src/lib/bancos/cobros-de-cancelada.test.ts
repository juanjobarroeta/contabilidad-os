import { describe, it, expect, vi, beforeEach } from "vitest";

const decisiones: unknown[] = [];
vi.mock("@/lib/decisiones", () => ({
  registrarDecisiones: (e: unknown[]) => decisiones.push(...e),
}));

import { liberarCobrosDeCancelada } from "./cobros-de-cancelada";

// ─────────────────────────────────────────────────────────────────────────────
// El cobro de una factura cancelada no puede quedarse colgado de ella: o pasa a
// la sustituta (04), o vuelve a la mesa. Medido en producción el 29-sep-2026: 2
// movimientos (18,325) conciliados contra canceladas, invisibles en el estado
// de cuenta del cliente.
// ─────────────────────────────────────────────────────────────────────────────

type Row = Record<string, any>;

function fakeDb(seed: { invoices: Row[]; txs: Row[]; detalles?: Row[] }) {
  const invoices = seed.invoices;
  const txs = seed.txs;
  let detalles = seed.detalles ?? [];
  const match = (r: Row, w: Row) =>
    Object.entries(w).every(([k, v]) => {
      if (v && typeof v === "object" && "in" in v) return (v.in as unknown[]).map((x) => String(x).toUpperCase()).includes(String(r[k]).toUpperCase());
      return r[k] === v;
    });
  const db: any = {
    invoice: {
      findUnique: async ({ where }: any) => invoices.find((i) => i.id === where.id) ?? null,
      findFirst: async ({ where }: any) => invoices.find((i) => match(i, where)) ?? null,
    },
    bankTransaction: {
      findMany: async ({ where }: any) => txs.filter((t) => match(t, where)),
      update: async ({ where, data }: any) => Object.assign(txs.find((t) => t.id === where.id)!, data),
      updateMany: async ({ where, data }: any) => {
        const ts = txs.filter((t) => match(t, where));
        ts.forEach((t) => Object.assign(t, data));
        return { count: ts.length };
      },
    },
    conciliacionDetalle: {
      findMany: async ({ where }: any) => detalles.filter((d) => match(d, where)),
      findFirst: async ({ where }: any) => detalles.find((d) => match(d, where)) ?? null,
      update: async ({ where, data }: any) => Object.assign(detalles.find((d) => d.id === where.id)!, data),
      delete: async ({ where }: any) => { detalles = detalles.filter((d) => d.id !== where.id); },
      count: async ({ where }: any) => detalles.filter((d) => match(d, where)).length,
    },
    get _detalles() { return detalles; },
  };
  return db;
}

const CANCELADA = { id: "c", companyId: "co", uuid: "AAAA-1", tipo: "INGRESO", status: "CANCELLED", sustituidoPorUuid: null as string | null };

beforeEach(() => { decisiones.length = 0; });

describe("liberarCobrosDeCancelada", () => {
  it("sin sustituta: el movimiento vuelve a la mesa, sin factura", async () => {
    const db = fakeDb({ invoices: [CANCELADA], txs: [{ id: "t1", invoiceId: "c", status: "MATCHED", monto: 14860 }] });
    const r = await liberarCobrosDeCancelada(db, "c");
    expect(r).toMatchObject({ movidos: 0, liberados: 1, monto: 14860, sustitutaId: null });
    const [t] = await db.bankTransaction.findMany({ where: { id: "t1" } });
    expect(t).toMatchObject({ invoiceId: null, status: "UNMATCHED" });
    expect(decisiones).toHaveLength(1);
  });

  it("con sustituta marcada: el cobro pasa a la sustituta y sigue conciliado", async () => {
    const db = fakeDb({
      invoices: [{ ...CANCELADA, sustituidoPorUuid: "BBBB-2" }, { id: "s", companyId: "co", uuid: "BBBB-2", tipo: "INGRESO", status: "STAMPED" }],
      txs: [{ id: "t1", invoiceId: "c", status: "MATCHED", monto: 3465 }],
    });
    const r = await liberarCobrosDeCancelada(db, "c");
    expect(r).toMatchObject({ movidos: 1, liberados: 0, sustitutaId: "s" });
    const [t] = await db.bankTransaction.findMany({ where: { id: "t1" } });
    expect(t).toMatchObject({ invoiceId: "s", status: "MATCHED" });
  });

  it("con sustituta por relación 04: también la encuentra", async () => {
    const db = fakeDb({
      invoices: [CANCELADA, { id: "s", companyId: "co", uuid: "BBBB-2", tipo: "INGRESO", status: "STAMPED", tipoRelacion: "04", cfdiRelacionadoUuid: "aaaa-1" }],
      txs: [{ id: "t1", invoiceId: "c", status: "MATCHED", monto: 100 }],
    });
    const r = await liberarCobrosDeCancelada(db, "c");
    expect(r.sustitutaId).toBe("s");
  });

  it("porción de un pago a varias facturas: se quita la porción; si no queda ninguna, el movimiento vuelve a la mesa", async () => {
    const db = fakeDb({
      invoices: [CANCELADA],
      txs: [
        { id: "t1", invoiceId: null, status: "MATCHED", monto: 500 },
        { id: "t2", invoiceId: null, status: "MATCHED", monto: 900 },
      ],
      detalles: [
        { id: "d1", bankTransactionId: "t1", invoiceId: "c", montoAsignado: 500 },
        { id: "d2", bankTransactionId: "t2", invoiceId: "c", montoAsignado: 400 },
        { id: "d3", bankTransactionId: "t2", invoiceId: "otra", montoAsignado: 500 },
      ],
    });
    const r = await liberarCobrosDeCancelada(db, "c");
    expect(r).toMatchObject({ liberados: 2, monto: 900 });
    const [t1] = await db.bankTransaction.findMany({ where: { id: "t1" } });
    const [t2] = await db.bankTransaction.findMany({ where: { id: "t2" } });
    expect(t1.status).toBe("UNMATCHED"); // no le quedó ninguna porción
    expect(t2.status).toBe("MATCHED"); // sigue pagando «otra»
    expect(db._detalles.map((d: Row) => d.id)).toEqual(["d3"]);
  });

  it("porción con sustituta que ya tenía porción en el mismo movimiento: se suman", async () => {
    const db = fakeDb({
      invoices: [{ ...CANCELADA, sustituidoPorUuid: "BBBB-2" }, { id: "s", companyId: "co", uuid: "BBBB-2", tipo: "INGRESO", status: "STAMPED" }],
      txs: [{ id: "t1", invoiceId: null, status: "MATCHED", monto: 1000 }],
      detalles: [
        { id: "d1", bankTransactionId: "t1", invoiceId: "c", montoAsignado: 300 },
        { id: "d2", bankTransactionId: "t1", invoiceId: "s", montoAsignado: 700 },
      ],
    });
    await liberarCobrosDeCancelada(db, "c");
    expect(db._detalles).toEqual([{ id: "d2", bankTransactionId: "t1", invoiceId: "s", montoAsignado: 1000 }]);
  });

  it("sin movimientos ligados no hace nada", async () => {
    const db = fakeDb({ invoices: [CANCELADA], txs: [] });
    expect(await liberarCobrosDeCancelada(db, "c")).toMatchObject({ movidos: 0, liberados: 0, monto: 0 });
    expect(decisiones).toHaveLength(0);
  });
});
