import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  membership: vi.fn(),
  companyFindUnique: vi.fn(),
  paymentFindMany: vi.fn(),
  invoiceFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/authz", () => ({ getEffectiveCompanyMembership: mocks.membership }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    company: { findUnique: mocks.companyFindUnique },
    pagoDoctoRelacionado: { findMany: mocks.paymentFindMany },
    invoice: { findMany: mocks.invoiceFindMany },
  },
}));

import { GET } from "./route";

const request = (query = "companyId=company-1&year=2026&month=8") =>
  new Request(`http://localhost/api/impuestos/asignaciones-regimen/ppd?${query}`);

const company = {
  regimenFiscal: "612",
  regimenes: [
    { code: "612", since: new Date("2024-01-01T00:00:00.000Z"), endedAt: null, active: true },
  ],
};

function link(id = "link-1", parentUuid = "PARENT-UUID") {
  return {
    id,
    parentUuid,
    impPagado: 580,
    fechaPago: new Date("2026-08-15T12:00:00.000Z"),
    pagoInvoice: { id: `rep-${id}`, uuid: `rep-uuid-${id}`, serie: "P", folio: "1" },
  };
}

function parent(extra: Record<string, unknown> = {}) {
  return {
    id: "parent-1",
    uuid: "parent-uuid",
    tipo: "INGRESO",
    status: "STAMPED",
    metodoPago: "PPD",
    fecha: new Date("2026-07-10T12:00:00.000Z"),
    serie: "A",
    folio: "42",
    subtotal: 1_000,
    total: 1_160,
    moneda: "MXN",
    contraparteNombre: "Cliente del CFDI",
    contraparteRfc: "XAXX010101000",
    customer: null,
    regimenAssignment: null,
    ...extra,
  };
}

describe("GET /api/impuestos/asignaciones-regimen/ppd", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } });
    mocks.membership.mockResolvedValue({ role: "VIEWER" });
    mocks.companyFindUnique.mockResolvedValue(company);
    mocks.paymentFindMany.mockResolvedValue([]);
    mocks.invoiceFindMany.mockResolvedValue([]);
  });

  it("returns 401 before reading fiscal data", async () => {
    mocks.auth.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.paymentFindMany).not.toHaveBeenCalled();
  });

  it("validates the monthly period", async () => {
    const response = await GET(request("companyId=company-1&year=2026&month=0"));

    expect(response.status).toBe(400);
    expect(mocks.membership).not.toHaveBeenCalled();
  });

  it("requires company membership", async () => {
    mocks.membership.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mocks.companyFindUnique).not.toHaveBeenCalled();
  });

  it("queries only stamped REP links whose FechaPago falls in the UTC month", async () => {
    await GET(request());

    expect(mocks.paymentFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        fechaPago: {
          gte: new Date("2026-08-01T00:00:00.000Z"),
          lt: new Date("2026-09-01T00:00:00.000Z"),
        },
        pagoInvoice: { companyId: "company-1", tipo: "PAGO", status: "STAMPED" },
      },
    }));
  });

  it("returns a complete empty state without querying parent invoices", async () => {
    const response = await GET(request());
    const body = await response.json();

    expect(body).toMatchObject({
      estado: "SIN_PAGOS_PPD",
      evidenciaCompleta: true,
      resumen: { totalRelaciones: 0, proyectables: 0, pendientes: 0 },
      usadaEnCalculoAutomatico: false,
    });
    expect(mocks.invoiceFindMany).not.toHaveBeenCalled();
  });

  it("projects a single-regime parent payment without fabricating an assignment", async () => {
    mocks.paymentFindMany.mockResolvedValue([link()]);
    mocks.invoiceFindMany.mockResolvedValue([parent()]);

    const response = await GET(request());
    const body = await response.json();

    expect(body).toMatchObject({
      estado: "COMPLETA",
      evidenciaCompleta: true,
      resumen: { totalRelaciones: 1, proyectables: 1, pendientes: 0 },
      pagosPendientes: [],
      usadaEnCalculoAutomatico: false,
    });
  });

  it("requires reviewed evidence for a multi-regime parent month", async () => {
    mocks.companyFindUnique.mockResolvedValue({
      regimenFiscal: "612",
      regimenes: [
        company.regimenes[0],
        { code: "606", since: new Date("2026-01-01T00:00:00.000Z"), endedAt: null, active: true },
      ],
    });
    mocks.paymentFindMany.mockResolvedValue([link()]);
    mocks.invoiceFindMany.mockResolvedValue([parent()]);

    const response = await GET(request());

    await expect(response.json()).resolves.toMatchObject({
      estado: "PENDIENTE",
      resumen: { totalRelaciones: 1, sinAsignacion: 1, pendientes: 1 },
      pagosPendientes: [{ code: "ASSIGNMENT_REQUIRED", parent: { invoiceId: "parent-1" } }],
    });
  });

  it("blocks a regime transition between the invoice and payment months", async () => {
    mocks.companyFindUnique.mockResolvedValue({
      regimenFiscal: "626",
      regimenes: [
        { code: "612", since: new Date("2024-01-01T00:00:00.000Z"), endedAt: new Date("2026-08-01T00:00:00.000Z"), active: false },
        { code: "626", since: new Date("2026-08-01T00:00:00.000Z"), endedAt: null, active: true },
      ],
    });
    mocks.paymentFindMany.mockResolvedValue([link()]);
    mocks.invoiceFindMany.mockResolvedValue([parent()]);

    const response = await GET(request());

    await expect(response.json()).resolves.toMatchObject({
      estado: "PENDIENTE",
      resumen: { transicionesRegimen: 1, pendientes: 1 },
      pagosPendientes: [{ code: "REGIME_TRANSITION_REVIEW", parent: { invoiceId: "parent-1" } }],
      usadaEnCalculoAutomatico: false,
    });
  });

  it("reports an unavailable parent instead of dropping the REP link", async () => {
    mocks.paymentFindMany.mockResolvedValue([link()]);

    const response = await GET(request());

    await expect(response.json()).resolves.toMatchObject({
      estado: "PENDIENTE",
      resumen: { sinFacturaPadre: 1, pendientes: 1 },
      pagosPendientes: [{ code: "PARENT_INVOICE_NOT_FOUND", parentUuid: "PARENT-UUID" }],
    });
  });

  it("fails closed for foreign-currency parents without stored REP equivalence", async () => {
    mocks.paymentFindMany.mockResolvedValue([link()]);
    mocks.invoiceFindMany.mockResolvedValue([parent({ moneda: "USD" })]);

    const response = await GET(request());

    await expect(response.json()).resolves.toMatchObject({
      estado: "PENDIENTE",
      resumen: { pendientes: 1, monedaExtranjera: 1, otros: 0 },
      pagosPendientes: [{ code: "FOREIGN_CURRENCY_REQUIRES_REVIEW", parent: { moneda: "USD" } }],
    });
  });

  it("bounds the pending preview while preserving exact counts", async () => {
    mocks.paymentFindMany.mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => link(`link-${index + 1}`, `missing-${index + 1}`)),
    );

    const response = await GET(request());
    const body = await response.json();

    expect(body.resumen).toMatchObject({ totalRelaciones: 30, pendientes: 30, sinFacturaPadre: 30 });
    expect(body.pagosPendientes).toHaveLength(25);
  });
});
