import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegimenIncomeInput } from "@/lib/fiscal/regimen-income-summary";
import { incomeEvidence } from "./fixtures/income-v1";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), membership: vi.fn(), transaction: vi.fn(), company: vi.fn(), invoices: vi.fn(), payments: vi.fn(), raw: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/authz", () => ({ getEffectiveCompanyMembership: mocks.membership }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));

import { GET } from "@/app/api/impuestos/asignaciones-regimen/ingresos/route";
import { INCOME_EVIDENCE_LIMIT } from "@/lib/fiscal/regimen-income-evidence";

let evidence: RegimenIncomeInput;
const request = (query = "companyId=company-1&year=2026&month=8") =>
  new Request(`https://qa.invalid/api/impuestos/asignaciones-regimen/ingresos?${query}`);
const decimal = (micros: number | null) => micros === null ? null : (micros / 1_000_000).toString();
const invoiceRow = (row: RegimenIncomeInput["issued"][number]) => ({
  id: row.id, uuid: row.uuid, fecha: new Date(row.fecha), tipo: row.tipo, tipoSat: row.tipoSat,
  status: row.status, sustituidoPorUuid: row.supersededBy, metodoPago: row.metodoPago, moneda: row.moneda,
  subtotal: decimal(row.subtotalMicros), descuento: decimal(row.descuentoMicros), total: decimal(row.totalMicros),
  regimenAssignment: row.assignment,
});
const paymentRow = (row: RegimenIncomeInput["payments"][number]) => ({
  id: row.id, parentUuid: row.parentUuid, impPagado: decimal(row.amountMicros),
  fechaPago: row.fechaPago ? new Date(row.fechaPago) : null, numParcialidad: row.installment,
  pagoInvoice: { uuid: row.repUuid, status: row.status, sustituidoPorUuid: row.supersededBy },
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network in fiscal fixtures"));
  evidence = incomeEvidence();
  mocks.auth.mockResolvedValue({ user: { id: "qa-user" } });
  mocks.membership.mockResolvedValue({ role: "VIEWER" });
  mocks.transaction.mockImplementation(async (read) => read({
    company: { findUnique: mocks.company }, invoice: { findMany: mocks.invoices }, pagoDoctoRelacionado: { findMany: mocks.payments }, $queryRaw: mocks.raw,
  }));
  mocks.company.mockResolvedValue({ regimenFiscal: "612", regimenes: [
    { code: "606", since: null, endedAt: null, active: true }, { code: "612", since: null, endedAt: null, active: true },
  ] });
  mocks.invoices.mockImplementation(async ({ where }) => {
    if (where.cfdiRelacionadoUuid) return evidence.linkedCreditNoteIds.map((id) => ({ id }));
    if (where.fecha) return evidence.issued.map(invoiceRow);
    return [...evidence.parents, ...evidence.issued]
      .filter((row) => row.uuid && where.uuid.in.includes(row.uuid)).map(invoiceRow);
  });
  mocks.payments.mockImplementation(async ({ where }) => (where.OR ? evidence.payments : evidence.history).map(paymentRow));
  mocks.raw.mockImplementation(async (query) => query.sql.includes('"PagoDoctoRelacionado"')
    ? [...evidence.payments, ...evidence.history].map((row) => ({ id: row.id, amount: decimal(row.amountMicros) }))
    : [...evidence.issued, ...evidence.parents].map((row) => ({ id: row.id, subtotal: decimal(row.subtotalMicros), descuento: decimal(row.descuentoMicros), total: decimal(row.totalMicros) })));
});
afterEach(() => {
  try { expect(globalThis.fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); }
});

describe("FISC-002M actual income evidence API and loader", () => {
  it("authenticates before reading any company or evidence", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(["", "companyId=c&year=2026&month=0", "companyId=c&year=2026&month=13", "companyId=c&year=1999&month=8", "companyId=c&year=no&month=8"])("rejects invalid scope %s before membership/data", async (query) => {
    expect((await GET(request(query))).status).toBe(400);
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("denies a different company before opening a data snapshot", async () => {
    mocks.membership.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(403);
    expect(mocks.membership).toHaveBeenCalledExactlyOnceWith("qa-user", "company-1");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("returns 404 for a missing company without scanning invoices", async () => {
    mocks.company.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(404);
    expect(mocks.invoices).not.toHaveBeenCalled();
  });
  it("returns the independently expected amounts without enabling tax calculation", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      estado: "PROYECTABLE", periodo: "2026-08", usadaEnCalculoAutomatico: false, pueAcreditaCobro: false,
      totales: { pueDocumentadoCentavos: 9000, ppdRepCentavos: 45000 },
      porRegimen: [
        { regimenCode: "606", pueDocumentadoCentavos: 3600, ppdRepCentavos: 18000 },
        { regimenCode: "612", pueDocumentadoCentavos: 5400, ppdRepCentavos: 27000 },
      ],
      resumen: { renglones: 2, pendientes: 0 },
    });
    expect(body).not.toHaveProperty("isr");
    expect(body).not.toHaveProperty("iva");
  });
  it("all queries remain company scoped in a repeatable-read transaction", async () => {
    await GET(request());
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead", timeout: 15000 });
    expect(mocks.company).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "company-1" }, select: expect.objectContaining({ regimenes: { select: { code: true, since: true, endedAt: true, active: true } } }),
    }));
    for (const [query] of mocks.invoices.mock.calls) {
      expect(query.where.companyId).toBe("company-1");
      expect(query.take).toBe(INCOME_EVIDENCE_LIMIT + 1);
    }
    for (const [query] of mocks.payments.mock.calls) {
      expect(query.where.pagoInvoice).toEqual({ companyId: "company-1", tipo: "PAGO", status: "STAMPED", sustituidoPorUuid: null });
      expect(query.take).toBe(INCOME_EVIDENCE_LIMIT + 1);
    }
    for (const [query] of mocks.raw.mock.calls) {
      expect(query.sql).toContain('"companyId" = ?');
      expect(query.values[0]).toBe("company-1");
      expect(query.sql).toContain("::text");
    }
  });
  it("uses UTC half-open month boundaries and does not drop missing payment dates", async () => {
    await GET(request());
    expect(mocks.invoices.mock.calls[0][0].where.fecha).toEqual({
      gte: new Date("2026-08-01T00:00:00Z"), lt: new Date("2026-09-01T00:00:00Z"),
    });
    expect(mocks.payments.mock.calls[0][0].where.OR).toEqual([
      { fechaPago: { gte: new Date("2026-08-01T00:00:00Z"), lt: new Date("2026-09-01T00:00:00Z") } },
      { fechaPago: null },
    ]);
    expect(mocks.payments.mock.calls[1][0].where).not.toHaveProperty("fechaPago");
    expect(mocks.payments.mock.calls[1][0].where).not.toHaveProperty("OR");
  });
  it("unknown dates produce pending/null rather than incomplete positive totals", async () => {
    evidence.payments[0].fechaPago = null;
    const body = await (await GET(request())).json();
    expect(body).toMatchObject({ estado: "PENDIENTE", totales: null, porRegimen: null });
    expect(body.pendientes).toContainEqual(expect.objectContaining({ code: "PAYMENT_DATE_UNAVAILABLE" }));
  });
  it("returns no-evidence nulls without querying unrelated historical records", async () => {
    evidence.issued = []; evidence.payments = [];
    const body = await (await GET(request())).json();
    expect(body).toMatchObject({ estado: "SIN_EVIDENCIA", totales: null, porRegimen: null });
    expect(mocks.invoices).toHaveBeenCalledTimes(1);
    expect(mocks.payments).toHaveBeenCalledTimes(1);
  });
  it("fails closed immediately when the issue-month scan exceeds its limit", async () => {
    evidence.issued = Array.from({ length: INCOME_EVIDENCE_LIMIT + 1 }, () => evidence.issued[0]);
    const body = await (await GET(request())).json();
    expect(body).toMatchObject({ estado: "PENDIENTE", totales: null, pendientes: [{ id: "periodo", code: "EVIDENCE_LIMIT_EXCEEDED" }] });
    expect(mocks.invoices).toHaveBeenCalledTimes(1);
    expect(mocks.payments).toHaveBeenCalledTimes(1);
  });
  it("fails closed when the cross-period history scan exceeds its limit", async () => {
    evidence.history = Array.from({ length: INCOME_EVIDENCE_LIMIT + 1 }, () => evidence.history[0]);
    const body = await (await GET(request())).json();
    expect(body).toMatchObject({ estado: "PENDIENTE", totales: null, pendientes: [{ id: "periodo", code: "EVIDENCE_LIMIT_EXCEEDED" }] });
    expect(mocks.invoices).toHaveBeenCalledTimes(2);
  });
  it("response previews are bounded without truncating whole-period totals", async () => {
    evidence.parents = []; evidence.payments = []; evidence.history = [];
    evidence.issued = Array.from({ length: 26 }, (_, index) => ({ ...evidence.issued[0], id: `i-${index}`, uuid: `UUID-${index}` }));
    const body = await (await GET(request())).json();
    expect(body.resumen).toEqual({ renglones: 26, pendientes: 0 });
    expect(body.renglones).toHaveLength(25);
    expect(body.totales).toEqual({ pueDocumentadoCentavos: 234000, ppdRepCentavos: 0 });
  });
  it("pending previews retain the exact issue count and null totals", async () => {
    evidence.parents = []; evidence.payments = []; evidence.history = [];
    evidence.issued = Array.from({ length: 26 }, (_, index) => ({ ...evidence.issued[0], id: `e-${index}`, uuid: `CREDIT-${index}`, tipoSat: "E" }));
    const body = await (await GET(request())).json();
    expect(body.resumen).toEqual({ renglones: 0, pendientes: 26 });
    expect(body.pendientes).toHaveLength(25);
    expect(body.totales).toBeNull();
  });
  it("database failure propagates instead of being reported as no income", async () => {
    mocks.transaction.mockRejectedValue(new Error("Database unavailable"));
    await expect(GET(request())).rejects.toThrow("Database unavailable");
  });
});
