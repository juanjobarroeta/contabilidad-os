import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ pendientes: vi.fn(), amparado: vi.fn(), reps: vi.fn() }));
vi.mock("@/lib/facturas/rep-pendientes", () => ({ pendientesRep: m.pendientes }));
vi.mock("@/lib/facturas/reps-amparados", () => ({ amparadoPorReps: m.amparado, repsPorFactura: m.reps }));

import { complementosHospital, formaPagoSat } from "./complementos";

const factura = { id: "f1", uuid: "AAAA", serie: "A", folio: "1", fecha: new Date("2026-09-01"), total: 10000, customer: { id: "c", rfc: "GNP9211244P0", razonSocial: "GNP" } };
const cobro = (id: string, monto: number, dia: string, formaPago = "TRANSFERENCIA") => ({ id, fecha: new Date(dia), monto, formaPago, tipoTarjeta: null, referencia: null, invoiceId: "f1", invoice: factura });

beforeEach(() => {
  vi.clearAllMocks();
  m.pendientes.mockResolvedValue({ pendientes: [], sinCobroDetectado: [] });
  m.reps.mockResolvedValue(new Map());
});

describe("forma de pago SAT del cobro de caja", () => {
  it("mapea efectivo, cheque, transferencia y tarjeta crédito/débito", () => {
    expect(formaPagoSat("EFECTIVO")).toBe("01");
    expect(formaPagoSat("CHEQUE")).toBe("02");
    expect(formaPagoSat("TRANSFERENCIA")).toBe("03");
    expect(formaPagoSat("TARJETA", "CREDITO")).toBe("04");
    expect(formaPagoSat("TARJETA", "DEBITO")).toBe("28");
  });
});

describe("siguiente REP sugerido", () => {
  const db = (cobros: unknown[]) => ({ hospCobro: { findMany: vi.fn().mockResolvedValue(cobros) } });

  it("lo amparado cubre los cobros más viejos; sugiere el primero sin cubrir", async () => {
    m.amparado.mockResolvedValue(new Map([["AAAA", 4000]]));
    const r = await complementosHospital(db([cobro("k1", 4000, "2026-09-05"), cobro("k2", 3000, "2026-09-10")]) as never, "co");
    const f = r.facturas[0];
    expect(f.saldo).toBe(6000);
    expect(f.cobrosCaja.map((c) => c.amparado)).toEqual([true, false]);
    expect(f.sugerido).toMatchObject({ cobroId: "k2", monto: 3000, formaPago: "03" });
  });

  it("sin cobros por amparar sugiere el saldo completo; saldada y sin REPs no aparece", async () => {
    m.amparado.mockResolvedValue(new Map([["AAAA", 7000]]));
    const r = await complementosHospital(db([cobro("k1", 7000, "2026-09-05")]) as never, "co");
    expect(r.facturas[0].sugerido).toMatchObject({ cobroId: null, monto: 3000 });
    m.amparado.mockResolvedValue(new Map([["AAAA", 10000]]));
    const r2 = await complementosHospital(db([cobro("k1", 10000, "2026-09-05")]) as never, "co");
    expect(r2.facturas).toHaveLength(0);
  });
});
