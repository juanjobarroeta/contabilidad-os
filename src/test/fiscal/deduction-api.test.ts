import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegimenDocumentInput } from "@/lib/fiscal/regimen-document-bases";
import { deductionEvidence } from "./fixtures/deduction-v1";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), membership: vi.fn(), transaction: vi.fn(), company: vi.fn(), invoices: vi.fn(), payments: vi.fn(), raw: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/authz", () => ({ getEffectiveCompanyMembership: mocks.membership }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));
import { GET } from "@/app/api/impuestos/asignaciones-regimen/deducciones/route";
import { DEDUCTION_EVIDENCE_LIMIT } from "@/lib/fiscal/regimen-deduction-evidence";

let evidence: RegimenDocumentInput;
const request = (query = "companyId=company-1&year=2026&month=8") => new Request(`https://qa.invalid/api/impuestos/asignaciones-regimen/deducciones?${query}`);
const decimal = (value: number | null) => value === null ? null : `${BigInt(value) / BigInt(1_000_000)}.${String(BigInt(value) % BigInt(1_000_000)).padStart(6, "0")}`;
const invoiceRow = (row: RegimenDocumentInput["issued"][number]) => ({
  id: row.id, uuid: row.uuid, fecha: new Date(row.fecha), tipo: row.tipo, tipoSat: row.tipoSat, status: row.status,
  sustituidoPorUuid: row.supersededBy, metodoPago: row.metodoPago, moneda: row.moneda, regimenAssignment: row.assignment, ...row.expense,
});
const paymentRow = (row: RegimenDocumentInput["payments"][number]) => ({
  id: row.id, parentUuid: row.parentUuid, fechaPago: row.fechaPago ? new Date(row.fechaPago) : null, numParcialidad: row.installment,
  pagoInvoice: { uuid: row.repUuid, status: row.status, sustituidoPorUuid: row.supersededBy },
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network in fiscal fixtures"));
  evidence = deductionEvidence();
  mocks.auth.mockResolvedValue({ user: { id: "qa-user" } });
  mocks.membership.mockResolvedValue({ role: "VIEWER" });
  mocks.transaction.mockImplementation(async (read) => read({ company: { findUnique: mocks.company }, invoice: { findMany: mocks.invoices }, pagoDoctoRelacionado: { findMany: mocks.payments }, $queryRaw: mocks.raw }));
  mocks.company.mockResolvedValue({ rfc: "FISD260101ABC", regimenFiscal: "612", regimenes: [
    { code: "606", since: null, endedAt: null, active: true }, { code: "612", since: null, endedAt: null, active: true },
  ] });
  mocks.invoices.mockImplementation(async ({ where }) => {
    if (where.cfdiRelacionadoUuid) return evidence.linkedCreditNoteIds.map((id) => ({ id }));
    if (where.fecha) return evidence.issued.map(invoiceRow);
    return [...evidence.parents, ...evidence.issued].filter((row) => row.uuid && where.uuid.in.includes(row.uuid)).map(invoiceRow);
  });
  mocks.payments.mockImplementation(async ({ where }) => (where.OR ? evidence.payments : evidence.history).map(paymentRow));
  mocks.raw.mockImplementation(async (query) => query.sql.includes('"PagoDoctoRelacionado"')
    ? [...evidence.payments, ...evidence.history].map((row) => ({ id: row.id, amount: decimal(row.amountMicros) }))
    : [...evidence.issued, ...evidence.parents].map((row) => ({ id: row.id, subtotal: decimal(row.subtotalMicros), descuento: decimal(row.descuentoMicros), total: decimal(row.totalMicros) })));
});
afterEach(() => { try { expect(globalThis.fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });

describe("FISC-002N actual deduction API and snapshot reader", () => {
  it("requires authentication before any membership or data read", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(401); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.membership).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(["", "companyId=c&year=2026&month=0", "companyId=c&year=2026&month=13", "companyId=c&year=1999&month=8", "companyId=c&year=NaN&month=8"])("rejects invalid scope %s without reads", async (query) => {
    expect((await GET(request(query))).status).toBe(400); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("denies another company before opening a snapshot", async () => {
    mocks.membership.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(403);
    expect(mocks.membership).toHaveBeenCalledExactlyOnceWith("qa-user", "company-1");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("returns missing company evidence as 404", async () => {
    mocks.company.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(404); expect(mocks.invoices).not.toHaveBeenCalled();
  });
  it("allows a VIEWER to read documentary amounts without granting eligibility", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      estado: "PENDIENTE", deduccionAutorizadaCentavos: null, usadaEnCalculoAutomatico: false, pueAcreditaPago: false,
      documental: { estado: "PROYECTABLE", totales: { pueDocumentadoCentavos: 9000, ppdRepCentavos: 45000 } },
      resumen: { renglones: 2, asignacionesPorRevisar: 4, pendientesDocumentales: 0 },
    });
    expect(body.renglones[0].clasificacion).toMatchObject({ origen: "MANUAL", naturaleza: "GASTO" });
    expect(body.renglones.flatMap((row: { elegibilidad: { deduccionAutorizadaCentavos: unknown }[] }) => row.elegibilidad)
      .every((review: { deduccionAutorizadaCentavos: unknown }) => review.deduccionAutorizadaCentavos === null)).toBe(true);
    expect(body).not.toHaveProperty("isr"); expect(body).not.toHaveProperty("rfc");
  });
  it("loads expense metadata and received credits in the same company-scoped snapshot", async () => {
    await GET(request());
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead", timeout: 15000 });
    expect(mocks.invoices.mock.calls[0][0]).toMatchObject({
      where: { companyId: "company-1", tipo: "EGRESO", status: "STAMPED", sustituidoPorUuid: null },
      select: { naturaleza: true, naturalezaManual: true, naturalezaRevision: true, usoCfdi: true, formaPago: true },
    });
    const creditQuery = mocks.invoices.mock.calls.find(([query]) => query.where.cfdiRelacionadoUuid)![0];
    expect(creditQuery.where.tipo).toBe("EGRESO"); expect(creditQuery.where.tipoSat).toBe("E");
    for (const [query] of mocks.invoices.mock.calls) { expect(query.where.companyId).toBe("company-1"); expect(query.take).toBe(DEDUCTION_EVIDENCE_LIMIT + 1); }
    for (const [query] of mocks.payments.mock.calls) expect(query.where.pagoInvoice).toMatchObject({ companyId: "company-1", tipo: "PAGO", status: "STAMPED", sustituidoPorUuid: null });
    for (const [query] of mocks.raw.mock.calls) { expect(query.sql).toContain("::text"); expect(query.values[0]).toBe("company-1"); }
  });
  it("does not inherit the PF treatment when the company RFC is PM", async () => {
    mocks.company.mockResolvedValue({ rfc: "FIS260101ABC", regimenFiscal: "626", regimenes: [] });
    for (const row of [...evidence.issued, ...evidence.parents]) row.assignment = null;
    const body = await (await GET(request())).json();
    const reasons = body.renglones.flatMap((row: { elegibilidad: { motivos: string[] }[] }) => row.elegibilidad.flatMap((review) => review.motivos));
    expect(reasons).toContain("RESICO_PM_TREATMENT_REVIEW"); expect(reasons).not.toContain("RESICO_PF_NO_ISR_DEDUCTION");
  });
  it("keeps no-data amounts unknown", async () => {
    evidence.issued = []; evidence.parents = []; evidence.payments = []; evidence.history = [];
    const body = await (await GET(request())).json();
    expect(body).toMatchObject({ estado: "SIN_EVIDENCIA", deduccionAutorizadaCentavos: null, documental: { totales: null } });
  });
  it("never presents a truncated scan as complete expense evidence", async () => {
    evidence.issued = Array.from({ length: DEDUCTION_EVIDENCE_LIMIT + 1 }, () => evidence.issued[0]);
    const body = await (await GET(request())).json();
    expect(body.documental).toMatchObject({ estado: "PENDIENTE", totales: null, pendientes: [{ id: "periodo", code: "EVIDENCE_LIMIT_EXCEEDED" }] });
    expect(mocks.raw).not.toHaveBeenCalled();
  });
  it("bounds previews but retains exact counts and whole-period documentary totals", async () => {
    evidence.parents = []; evidence.payments = []; evidence.history = [];
    evidence.issued = Array.from({ length: 26 }, (_, index) => ({ ...evidence.issued[0], id: `expense-${index}`, uuid: `UUID-${index}` }));
    const body = await (await GET(request())).json();
    expect(body.renglones).toHaveLength(25);
    expect(body.resumen).toMatchObject({ renglones: 26, asignacionesPorRevisar: 52 });
    expect(body.resumen.porMotivo).toContainEqual({ code: "PUE_PAYMENT_EVIDENCE_REQUIRED", count: 52 });
    expect(body.documental.totales).toEqual({ pueDocumentadoCentavos: 234000, ppdRepCentavos: 0 });
    expect(body.deduccionAutorizadaCentavos).toBeNull();
  });
  it("bounds documentary issue previews without hiding their total count", async () => {
    evidence.parents = []; evidence.payments = []; evidence.history = [];
    evidence.issued = Array.from({ length: 26 }, (_, index) => ({ ...evidence.issued[0], id: `credit-${index}`, uuid: `CREDIT-${index}`, tipoSat: "E" }));
    const body = await (await GET(request())).json();
    expect(body.documental.pendientes).toHaveLength(25); expect(body.resumen.pendientesDocumentales).toBe(26);
    expect(body.documental.totales).toBeNull();
  });
  it("database failure is not converted to an empty or zero deduction result", async () => {
    mocks.transaction.mockRejectedValue(new Error("Database unavailable"));
    await expect(GET(request())).rejects.toThrow("Database unavailable");
  });
});
