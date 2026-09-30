import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ find: vi.fn(), update: vi.fn(), reps: vi.fn(), cancel: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { invoice: { findUnique: m.find, update: m.update }, pagoDoctoRelacionado: { findMany: m.reps } },
}));
vi.mock("@/lib/pac", () => ({ getPacProvider: () => ({ cancelCfdi: m.cancel }) }));
vi.mock("@/lib/audit", () => ({ registrarBitacora: vi.fn() }));

import { cancelarCfdi } from "./cancelar";

const base = { actor: { id: "u" }, req: new Request("https://x.test"), invoiceId: "i1" };
const factura = { id: "i1", companyId: "c", uuid: "AAAA", status: "STAMPED", facturapiId: "fp", total: 116, company: { facturapiApiKey: "k" } };

beforeEach(() => {
  vi.clearAllMocks();
  m.find.mockResolvedValue(factura);
  m.reps.mockResolvedValue([]);
  m.update.mockImplementation(({ data }) => Promise.resolve({ ...factura, ...data }));
});

describe("cancelar CFDI", () => {
  it("valida el motivo y exige el UUID sustituto con 01", async () => {
    expect((await cancelarCfdi({ ...base, motivo: "05" })).status).toBe(400);
    expect((await cancelarCfdi({ ...base, motivo: "01" })).status).toBe(400);
    expect((await cancelarCfdi({ ...base, motivo: "01", sustituyeUuid: "aaaa" })).status).toBe(400);
    expect(m.cancel).not.toHaveBeenCalled();
  });
  it("no cancela una factura con complementos de pago vivos", async () => {
    m.reps.mockResolvedValue([{ pagoInvoice: { serie: "P", folio: "9", uuid: "X" } }]);
    const r = await cancelarCfdi({ ...base, motivo: "02" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: "REPS_VIVOS" });
  });
  it("si el SAT rechaza, no la marca cancelada", async () => {
    m.cancel.mockResolvedValue({ ok: false, status: 502, message: "no", kind: "pac" });
    expect((await cancelarCfdi({ ...base, motivo: "02" })).status).toBe(502);
    expect(m.update).not.toHaveBeenCalled();
  });
  it("consumada → CANCELLED; en proceso → sigue timbrada con la solicitud registrada", async () => {
    m.cancel.mockResolvedValue({ ok: true, data: { estado: "cancelado", detalle: null } });
    await cancelarCfdi({ ...base, motivo: "01", sustituyeUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" });
    expect(m.update.mock.calls[0][0].data).toMatchObject({ status: "CANCELLED", cancelMotivo: "01", cancelSustituyeUuid: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB" });
    m.cancel.mockResolvedValue({ ok: true, data: { estado: "en_proceso", detalle: null } });
    const r = await cancelarCfdi({ ...base, motivo: "02" });
    expect(m.update.mock.calls[1][0].data.status).toBeUndefined();
    expect(r.body).toMatchObject({ cancelacion: { consumada: false } });
  });
});
