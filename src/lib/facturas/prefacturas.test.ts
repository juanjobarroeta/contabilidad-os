import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  company: vi.fn(),
  customer: vi.fn(),
  borradorCreate: vi.fn(),
  borradorUpdate: vi.fn(),
  ensure: vi.fn(),
  createDraft: vi.fn(),
  discard: vi.fn(),
  stamp: vi.fn(),
  cargosCount: vi.fn(),
  cargosUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    company: { findUnique: m.company },
    customer: { findUnique: m.customer },
    facturaBorrador: { create: m.borradorCreate, update: m.borradorUpdate },
    hospCargo: { count: m.cargosCount, updateMany: m.cargosUpdate },
  },
}));
vi.mock("@/lib/facturapi", () => ({ ensureFacturapiCustomer: m.ensure, getFacturapiClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ registrarBitacora: vi.fn() }));
vi.mock("@/lib/facturas/stamp", () => ({ createDraftInvoice: m.createDraft, discardDraft: m.discard, stampDraftFromPending: m.stamp }));
vi.mock("@/lib/facturas/prefactura", () => ({ pdfUrlCliente: () => "https://pdf", totalEstimadoPrefactura: () => "116.00" }));

import { crearPrefactura, editarPrefactura, timbrarPrefactura } from "./prefacturas";

const actor = { id: "u1", email: "caja@h.mx" };
const req = new Request("https://local.test/x", { method: "POST" });
const input = {
  companyId: "c1",
  customerId: "cu1",
  formaPago: "01",
  metodoPago: "PUE" as const,
  usoCfdi: "D01",
  items: [{ quantity: 1, product: { description: "Consulta", product_key: "85121600", price: 100 } }],
};
const borrador = (status = "PENDIENTE") =>
  ({ id: "b1", companyId: "c1", customerId: "cu1", draftId: "d-old", status, payload: input, customer: { email: null, razonSocial: "X" } }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.company.mockResolvedValue({ facturapiApiKey: "key" });
  m.customer.mockResolvedValue({ id: "cu1", companyId: "c1", facturapiId: null });
  m.ensure.mockResolvedValue({ ok: true, facturapiId: "fp1" });
  m.createDraft.mockResolvedValue({ ok: true, draftId: "d-new" });
  m.borradorCreate.mockResolvedValue({ id: "b1" });
  m.cargosCount.mockResolvedValue(0);
});

describe("prefacturas", () => {
  it("syncs a new customer with Facturapi before drafting", async () => {
    const r = await crearPrefactura(input, actor, req);
    expect(m.ensure).toHaveBeenCalledOnce();
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: "b1", draftId: "d-new", total: 116, pdfUrl: "https://pdf" });
  });

  it("stops with the sync error instead of drafting for an unsynced customer", async () => {
    m.ensure.mockResolvedValue({ ok: false, error: "Falta el código postal fiscal" });
    const r = await crearPrefactura(input, actor, req);
    expect(r).toEqual({ status: 422, body: { error: "Falta el código postal fiscal" } });
    expect(m.createDraft).not.toHaveBeenCalled();
  });

  it("does not try to sync a customer from another company", async () => {
    m.customer.mockResolvedValue({ id: "cu1", companyId: "other" });
    m.createDraft.mockResolvedValue({ ok: false, status: 404, error: "Cliente no encontrado." });
    const r = await crearPrefactura(input, actor, req);
    expect(m.ensure).not.toHaveBeenCalled();
    expect(r.status).toBe(404);
  });

  it("edits by drafting first and discarding the old draft only after success", async () => {
    m.createDraft.mockResolvedValue({ ok: false, status: 422, error: "rechazado" });
    const fallo = await editarPrefactura(borrador(), input, actor, req);
    expect(fallo.status).toBe(422);
    expect(m.discard).not.toHaveBeenCalled();

    m.createDraft.mockResolvedValue({ ok: true, draftId: "d-new" });
    const ok = await editarPrefactura(borrador(), input, actor, req);
    expect(ok.status).toBe(200);
    expect(m.discard).toHaveBeenCalledWith("c1", "d-old");
  });

  it("refuses to edit or stamp a prefactura that is no longer pending", async () => {
    expect((await editarPrefactura(borrador("TIMBRADA"), input, actor, req)).status).toBe(409);
    expect((await timbrarPrefactura(borrador("DESCARTADA"), actor, req)).status).toBe(409);
    expect(m.stamp).not.toHaveBeenCalled();
  });

  it("stamps exactly the saved draft and marks it TIMBRADA", async () => {
    m.stamp.mockResolvedValue({ ok: true, invoiceId: "inv1", uuid: "UUID", total: 116 });
    const r = await timbrarPrefactura(borrador(), actor, req);
    expect(m.stamp).toHaveBeenCalledWith(input, "d-old");
    expect(m.borradorUpdate).toHaveBeenCalledWith({ where: { id: "b1" }, data: { status: "TIMBRADA", invoiceId: "inv1" } });
    expect(r).toEqual({ status: 200, body: { ok: true, invoiceId: "inv1", uuid: "UUID", total: 116 } });
  });

  it("links the hospital charges the prefactura took to the stamped CFDI", async () => {
    m.stamp.mockResolvedValue({ ok: true, invoiceId: "inv1", uuid: "UUID", total: 116 });
    await timbrarPrefactura(borrador(), actor, req);
    expect(m.cargosUpdate).toHaveBeenCalledWith({ where: { prefacturaId: "b1", invoiceId: null }, data: { invoiceId: "inv1" } });
  });

  it("will not hand-edit a prefactura built from an episode account", async () => {
    m.cargosCount.mockResolvedValue(2);
    const r = await editarPrefactura(borrador(), input, actor, req);
    expect(r.status).toBe(409);
    expect(m.createDraft).not.toHaveBeenCalled();
  });
});
