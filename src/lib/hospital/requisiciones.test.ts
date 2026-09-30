import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  sol: vi.fn(), adj: vi.fn(), adjUpdate: vi.fn(), solUpdate: vi.fn(), tx: vi.fn(), exec: vi.fn(), partida: vi.fn(),
  gen: vi.fn(), aplicado: vi.fn(), aplicar: vi.fn(), pagoCreate: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    solicitudCompra: { findUnique: m.sol, update: m.solUpdate },
    solicitudAdjudicacion: { findUnique: m.adj, update: m.adjUpdate },
    solicitudPartida: { findUnique: m.partida },
    $transaction: m.tx,
    $executeRaw: m.exec,
  },
}));
vi.mock("@/lib/construccion/adjudicaciones", () => ({ generateAdjudicaciones: m.gen }));
vi.mock("@/lib/construccion/pagos-proveedor", () => ({
  aplicadoDeAdjudicacion: m.aplicado,
  aplicarPago: m.aplicar,
  saldoDe: (a: { total: number }, ap: number) => Math.max(0, a.total - ap),
}));

import {
  aprobarRequisicion, autorizarPago, etapaDe, recibirManual, registrarPago, validarCantidadRecibida, vencimientoDe,
} from "./requisiciones";

const req = { id: "s1", companyId: "c", folio: "REQ-2026-0001", estado: "PENDIENTE", origen: "HOSPITAL", creadaPorId: "ana", total: 100 };
const orden = {
  id: "o1", companyId: "c", estado: "POR_PAGAR", total: 1000, supplierId: "p1", supplierNombre: "Prov", solicitudId: "s1",
  enviadaTesoreriaAt: new Date(), pagoAutorizadoPorId: "dir",
  solicitud: { origen: "HOSPITAL", folio: "REQ-2026-0001", creadaPorId: "ana", aprobadaAt: new Date(), supplier: { rfc: "AAA010101AAA" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.sol.mockResolvedValue(req);
  m.adj.mockResolvedValue(orden);
  m.tx.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({
      solicitudCompra: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      solicitudAdjudicacion: { findFirst: vi.fn().mockResolvedValue({ id: "o1" }), update: vi.fn() },
      pagoProveedor: { create: m.pagoCreate.mockResolvedValue({ id: "pg1" }) },
    })
  );
  m.aplicado.mockResolvedValue(0);
});

describe("separación de funciones", () => {
  it("nadie autoriza su propia requisición", async () => {
    await expect(aprobarRequisicion("s1", "c", "ana")).rejects.toMatchObject({ status: 403 });
    const r = await aprobarRequisicion("s1", "c", "dir");
    expect(r.ordenId).toBe("o1");
    expect(m.gen).toHaveBeenCalled();
  });
  it("sólo se autoriza una requisición por autorizar, y sólo del hospital", async () => {
    m.sol.mockResolvedValueOnce({ ...req, estado: "APROBADA" });
    await expect(aprobarRequisicion("s1", "c", "dir")).rejects.toMatchObject({ status: 409 });
    m.sol.mockResolvedValueOnce({ ...req, origen: null });
    await expect(aprobarRequisicion("s1", "c", "dir")).rejects.toMatchObject({ status: 404 });
  });
  it("quien pidió no autoriza el pago", async () => {
    await expect(autorizarPago("o1", "c", "ana")).rejects.toMatchObject({ status: 403 });
    await autorizarPago("o1", "c", "dir");
    expect(m.adjUpdate.mock.calls[0][0].data).toMatchObject({ pagoAutorizadoPorId: "dir" });
  });
  it("tesorería paga sólo lo autorizado, y no lo paga quien lo autorizó", async () => {
    m.adj.mockResolvedValueOnce({ ...orden, enviadaTesoreriaAt: null });
    await expect(registrarPago("o1", "c", "teso", {})).rejects.toMatchObject({ status: 409 });
    await expect(registrarPago("o1", "c", "dir", {})).rejects.toMatchObject({ status: 403 });
    const r = await registrarPago("o1", "c", "teso", { monto: 400, referencia: "SPEI 123" });
    expect(r).toMatchObject({ monto: 400, saldo: 600 });
    expect(m.aplicar.mock.calls[0][2]).toEqual([{ adjudicacionId: "o1", monto: 400 }]);
  });
  it("no se paga de más: el monto se topa al saldo", async () => {
    m.aplicado.mockResolvedValue(900);
    const r = await registrarPago("o1", "c", "teso", { monto: 5000 });
    expect(r.monto).toBe(100);
  });
});

describe("recepción", () => {
  it("no se recibe de más", () => {
    expect(() => validarCantidadRecibida({ cantidad: 10, cantidadRecibida: 8 }, 3)).toThrow(/Sólo faltan 2/);
    expect(() => validarCantidadRecibida({ cantidad: 10, cantidadRecibida: 8 }, 2)).not.toThrow();
  });
  it("un insumo de farmacia se recibe con lote, no a mano", async () => {
    m.partida.mockResolvedValue({ id: "l1", cantidad: 5, cantidadRecibida: 0, hospInsumoId: "i1", solicitud: { companyId: "c", estado: "APROBADA", origen: "HOSPITAL" } });
    await expect(recibirManual("l1", "c", 1)).rejects.toMatchObject({ status: 409 });
  });
  it("una línea de requisición sin autorizar no se recibe", async () => {
    m.partida.mockResolvedValue({ id: "l1", cantidad: 5, cantidadRecibida: 0, hospInsumoId: null, solicitud: { companyId: "c", estado: "PENDIENTE", origen: "HOSPITAL" } });
    await expect(recibirManual("l1", "c", 1)).rejects.toMatchObject({ status: 409 });
  });
});

describe("vencimiento y etapa", () => {
  const d = (s: string) => new Date(`${s}T12:00:00Z`);
  it("vence a los días de crédito desde la factura más vieja; sin factura, desde la autorización", () => {
    expect(vencimientoDe({ aprobadaAt: d("2026-09-01"), tieneCredito: true, diasCredito: 30, fechasCfdi: [d("2026-09-10"), d("2026-09-05")] })).toEqual(d("2026-10-05"));
    expect(vencimientoDe({ aprobadaAt: d("2026-09-01"), tieneCredito: true, diasCredito: 30, fechasCfdi: [] })).toEqual(d("2026-10-01"));
    expect(vencimientoDe({ aprobadaAt: d("2026-09-01"), tieneCredito: false, diasCredito: 30, fechasCfdi: [] })).toEqual(d("2026-09-01"));
  });
  it("la etapa sigue el camino recibir → facturar → autorizar → tesorería → pagada → conciliada", () => {
    const base = { total: 100, saldo: 100, recepcionCompleta: false, facturado: 0, autorizada: false, conciliado: false };
    expect(etapaDe(base)).toBe("POR_RECIBIR");
    expect(etapaDe({ ...base, recepcionCompleta: true })).toBe("POR_FACTURAR");
    expect(etapaDe({ ...base, facturado: 100 })).toBe("POR_AUTORIZAR_PAGO");
    expect(etapaDe({ ...base, facturado: 100, autorizada: true })).toBe("EN_TESORERIA");
    expect(etapaDe({ ...base, saldo: 0 })).toBe("PAGADA");
    expect(etapaDe({ ...base, saldo: 0, conciliado: true })).toBe("CONCILIADA");
  });
});
