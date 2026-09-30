import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ item: vi.fn(), inv: vi.fn(), company: vi.fn(), cancel: vi.fn(), tx: vi.fn(), invUpd: vi.fn(), itemUpd: vi.fn(), count: vi.fn(), runUpd: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    payrollItem: { findUnique: m.item },
    invoice: { findFirst: m.inv },
    company: { findUnique: m.company },
    $transaction: m.tx,
  },
}));
vi.mock("@/lib/pac", () => ({ getPacProvider: () => ({ cancelCfdi: m.cancel }) }));
vi.mock("@/lib/audit", () => ({ registrarBitacora: vi.fn() }));

import { cancelarReciboNomina } from "./cancelar-recibo";

const base = { companyId: "c", payrollItemId: "pi", actor: { id: "u" } };
const item = { id: "pi", cfdiUuid: "AAA", payrollRunId: "r", employee: { nombre: "Ana", apellidoPaterno: "Ruiz" }, payrollRun: { id: "r", companyId: "c", status: "STAMPED", extraData: {} } };

beforeEach(() => {
  vi.clearAllMocks();
  m.item.mockResolvedValue(item);
  m.inv.mockResolvedValue({ id: "i", uuid: "AAA", facturapiId: "fp", status: "STAMPED" });
  m.company.mockResolvedValue({ facturapiApiKey: "k" });
  m.count.mockResolvedValue(3);
  m.tx.mockImplementation((fn) => fn({ invoice: { update: m.invUpd }, payrollItem: { update: m.itemUpd, count: m.count }, payrollRun: { update: m.runUpd } }));
});

describe("cancelar recibo de nómina", () => {
  it("valida el motivo y exige el UUID sustituto con 01", async () => {
    expect((await cancelarReciboNomina({ ...base, motivo: "09" })).status).toBe(400);
    expect((await cancelarReciboNomina({ ...base, motivo: "01" })).status).toBe(400);
    expect(m.cancel).not.toHaveBeenCalled();
  });
  it("recibo de otra empresa → 404; importado del SAT → 422", async () => {
    m.item.mockResolvedValueOnce({ ...item, payrollRun: { ...item.payrollRun, companyId: "otra" } });
    expect((await cancelarReciboNomina({ ...base, motivo: "02" })).status).toBe(404);
    m.inv.mockResolvedValueOnce({ id: "i", uuid: "AAA", facturapiId: null, status: "STAMPED" });
    expect((await cancelarReciboNomina({ ...base, motivo: "02" })).status).toBe(422);
  });
  it("si el SAT rechaza, no toca nada local", async () => {
    m.cancel.mockResolvedValue({ ok: false, status: 502, message: "no", kind: "pac" });
    expect((await cancelarReciboNomina({ ...base, motivo: "02" })).status).toBe(502);
    expect(m.tx).not.toHaveBeenCalled();
  });
  it("cancelado: limpia el CFDI del renglón y regresa la corrida a CALCULATED", async () => {
    m.cancel.mockResolvedValue({ ok: true, data: {} });
    const r = await cancelarReciboNomina({ ...base, motivo: "02" });
    expect(r.status).toBe(200);
    expect(m.invUpd.mock.calls[0][0].data).toMatchObject({ status: "CANCELLED", cancelMotivo: "02" });
    expect(m.itemUpd.mock.calls[0][0].data).toEqual({ cfdiUuid: null, facturapiId: null });
    expect(m.runUpd.mock.calls[0][0].data).toMatchObject({ status: "CALCULATED", extraData: { stampedCount: 3 } });
  });
});
