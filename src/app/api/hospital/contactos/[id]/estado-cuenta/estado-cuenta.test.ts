/**
 * Estado de cuenta documental del contacto: sólo CFDIs vigentes, y cada pago
 * se aplica a la factura que dice su XML sin pasar de lo que debe — un REP de
 * 2026 que paga una factura de 2025 abona a ésa (que viene en el saldo
 * anterior), y una PUE con REP no se paga dos veces.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  facturas: [] as Array<Record<string, unknown>>,
  reps: [] as Array<Record<string, unknown>>,
  whereFacturas: null as unknown,
  whereReps: null as unknown,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    customer: { findUnique: vi.fn(async () => ({ id: "k1", companyId: "c1", razonSocial: "PROVEEDOR SA", rfc: "PRO010101AAA", email: null, phone: null })) },
    invoice: { findMany: vi.fn(async (a: { where: unknown }) => { estado.whereFacturas = a.where; return estado.facturas }) },
    pagoDoctoRelacionado: { findMany: vi.fn(async (a: { where: unknown }) => { estado.whereReps = a.where; return estado.reps }) },
  },
}));

vi.mock("@/lib/authz", () => {
  class AuthzError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  }
  return {
    AuthzError,
    requireMembership: vi.fn(async () => undefined),
    requireModule: vi.fn(async () => undefined),
    withAuthz: (h: (...a: unknown[]) => Promise<Response>) => h,
  };
});

import { GET } from "./route";

const U25 = "AAAAAAAA-0000-0000-0000-000000000025";
const U26 = "AAAAAAAA-0000-0000-0000-000000000026";
const factura = (o: Record<string, unknown>) => ({ serie: "F", tipoSat: "I", conciliacionDetalles: [], ...o });
const rep = (o: Record<string, unknown>) => ({ numParcialidad: 1, pagoInvoiceId: "p1", pagoInvoice: { fecha: o.fechaPago }, ...o });

async function edoCuenta(year = 2026) {
  const r = await GET(new Request(`http://x/api/hospital/contactos/k1/estado-cuenta?direccion=PROVEEDOR&year=${year}`), { params: Promise.resolve({ id: "k1" }) });
  return r.json();
}

beforeEach(() => {
  estado.facturas = [];
  estado.reps = [];
});

describe("estado de cuenta del contacto", () => {
  it("sólo cuenta facturas y REPs vigentes de la empresa", async () => {
    estado.facturas = [factura({ id: "f1", uuid: U26, folio: "1", fecha: new Date(2026, 1, 1), total: 100, metodoPago: "PPD" })];
    await edoCuenta();
    expect(estado.whereFacturas).toMatchObject({ status: { not: "CANCELLED" }, sustituidoPorUuid: null });
    expect(estado.whereReps).toMatchObject({ pagoInvoice: { companyId: "c1", tipo: "PAGO", status: { not: "CANCELLED" }, sustituidoPorUuid: null } });
  });

  it("un REP de 2026 abona a la factura de 2025 que viene en el saldo anterior", async () => {
    estado.facturas = [
      factura({ id: "f25", uuid: U25, folio: "25", fecha: new Date(2025, 10, 15), total: 1000, metodoPago: "PPD" }),
      factura({ id: "f26", uuid: U26, folio: "26", fecha: new Date(2026, 0, 20), total: 500, metodoPago: "PPD" }),
    ];
    estado.reps = [rep({ parentUuid: U25, impPagado: 1000, fechaPago: new Date(2026, 1, 3) })];
    const d = await edoCuenta();
    expect(d.saldoAnterior).toBe(1000);
    const pago = d.movimientos.find((m: { tipo: string }) => m.tipo === "PAGO_REP");
    expect(pago).toMatchObject({ abono: 1000, referencia: "F-25" });
    expect(pago.concepto).toContain("del 15/11/2025");
    expect(d.resumen.saldoFinal).toBe(500);
  });

  it("un REP no paga más de lo que debe su factura", async () => {
    estado.facturas = [factura({ id: "f26", uuid: U26, folio: "26", fecha: new Date(2026, 0, 20), total: 500, metodoPago: "PPD" })];
    estado.reps = [
      rep({ parentUuid: U26, impPagado: 400, fechaPago: new Date(2026, 1, 1) }),
      rep({ parentUuid: U26, impPagado: 400, numParcialidad: 2, pagoInvoiceId: "p2", fechaPago: new Date(2026, 2, 1) }),
    ];
    const d = await edoCuenta();
    expect(d.movimientos.filter((m: { tipo: string }) => m.tipo === "PAGO_REP").map((m: { abono: number }) => m.abono)).toEqual([400, 100]);
    expect(d.resumen.saldoFinal).toBe(0);
  });

  it("una PUE con REP no se paga dos veces: el REP en su fecha, la PUE implícita sólo el resto", async () => {
    estado.facturas = [factura({ id: "f25", uuid: U25, folio: "25", fecha: new Date(2025, 10, 15), total: 1000, metodoPago: "PUE" })];
    estado.reps = [rep({ parentUuid: U25, impPagado: 600, fechaPago: new Date(2026, 1, 3) })];
    const d = await edoCuenta();
    expect(d.saldoAnterior).toBe(600);
    expect(d.movimientos.map((m: { tipo: string; abono: number }) => [m.tipo, m.abono])).toEqual([["PAGO_REP", 600]]);
    expect(d.resumen.saldoFinal).toBe(0);
  });
});
