import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ userId: "itest-mochi-doc-owner", pacCreate: vi.fn(), pacStamp: vi.fn(), payrollStamp: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: mock.userId } }) }));
vi.mock("@/lib/subscription", () => ({ assertPuedeEscribir: async () => ({}), gateEscritura: async () => null }));
vi.mock("@/lib/facturapi", () => ({ ensureFacturapiCustomer: async () => ({ ok: true, facturapiId: "synthetic-customer" }), getFacturapiClient: () => ({ invoices: { create: mock.payrollStamp } }) }));
vi.mock("@/lib/pac", () => ({ getPacProvider: () => ({ createDraft: mock.pacCreate, stampDraft: mock.pacStamp }) }));
vi.mock("@/lib/costos/record", () => ({ recordTimbrado: async () => {} }));
import { persistChatUserTurn } from "@/lib/ai/user-turn";
import { prisma } from "@/lib/prisma";
import { executeDocumentTool } from "./executor";
import { readDocument } from "./read";
import { reviewDocument, confirmDocumentStamp } from "./stamping";
import { createPayrollRun, stampPayrollRun } from "@/lib/nomina/payroll-run";
import { previewRecibo } from "@/lib/nomina/preview-recibo";
import { emitNominaCfdi } from "@/lib/nomina/emit-nomina";
import { cargarPrefactura, timbrarPrefactura } from "@/lib/facturas/prefacturas";
import { GET, POST } from "@/app/api/ai/documentos/route";
import type { DocumentRef } from "./contract";

const A = "itest-mochi-doc-a", B = "itest-mochi-doc-b", U = "itest-mochi-doc-owner", V = "itest-mochi-doc-viewer";
const skip = process.env.DB_TESTS_SKIP === "1";
let conv: string, customer: string, employee: string;
const req = () => new Request("https://app.test/api/ai/documentos", { method: "POST" });
const payrollInput = () => ({ companyId: A, tipo: "ORDINARIA" as const, periodoInicio: new Date("2026-09-01T12:00:00Z"), periodoFin: new Date("2026-09-15T12:00:00Z"), fechaPago: new Date("2026-09-15T12:00:00Z"), diasPagados: 15, employeeIds: [employee] });
const input = () => ({ customer_id: customer, forma_pago: "03", metodo_pago: "PUE", uso_cfdi: "G03", items: [{ description: "Synthetic service", product_key: "84111506", unit_key: "E48", quantity: 1, unit_price: 100, taxes: [{ type: "IVA", rate: 0.16, factor: "Tasa", withholding: false }] }] });
async function draft() {
  const result = JSON.parse(await executeDocumentTool("preparar_prefactura", input(), A, { userId: U, conversationId: conv, inApp: true }));
  expect(result.error).toBeUndefined();
  return result.documents[0] as DocumentRef;
}
async function cleanup() {
  await prisma.payrollRun.deleteMany({ where: { companyId: { in: [A, B] } } });
  await prisma.facturaBorrador.deleteMany({ where: { companyId: { in: [A, B] } } });
  await prisma.auditLog.deleteMany({ where: { companyId: { in: [A, B] } } });
  await prisma.company.deleteMany({ where: { id: { in: [A, B] } } });
  await prisma.user.deleteMany({ where: { id: { in: [U, V] } } });
}
describe.skipIf(skip)("Mochi documents: real DB and synthetic PAC only", () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.user.createMany({ data: [U, V].map((id) => ({ id, email: `${id}@test.invalid` })) });
    await prisma.company.createMany({ data: [A, B].map((id, i) => ({ id, rfc: i ? "MDB261001BB1" : "MDA261001AA1", razonSocial: id, regimenFiscal: "601", codigoPostal: "06600", registroPatronal: "Y1234567890", facturapiApiKey: "synthetic-never-real-key" })) });
    await prisma.companyMember.createMany({ data: [{ companyId: A, userId: U, role: "OWNER" }, { companyId: A, userId: V, role: "VIEWER" }] });
    customer = (await prisma.customer.create({ data: { companyId: A, razonSocial: "SYNTHETIC RECEIVER", rfc: "SYN261001AA1", regimenFiscal: "601", codigoPostal: "06600", facturapiId: "synthetic-customer" } })).id;
    employee = (await prisma.employee.create({ data: { companyId: A, nombre: "Synthetic", apellidoPaterno: "Employee", rfc: "SYN010101AA12", curp: "SYN010101HDFXXX00", nss: "12345678901", codigoPostal: "06600", fechaIngreso: new Date("2025-01-01"), tipoContrato: "01", tipoJornada: "01", salarioDiario: 500, salarioDiarioIntegrado: 525, periodicidadPago: "04" } })).id;
  });
  afterAll(cleanup);
  beforeEach(async () => {
    mock.userId = U;
    vi.clearAllMocks();
    mock.pacCreate.mockImplementation(async () => ({ ok: true, data: { draftId: `draft-${randomUUID()}` } }));
    mock.pacStamp.mockImplementation(async () => ({ ok: true, data: { pacId: `invoice-${randomUUID()}`, uuid: randomUUID(), total: 116, subtotal: 100 } }));
    mock.payrollStamp.mockImplementation(async () => ({ id: `payroll-${randomUUID()}`, uuid: randomUUID() }));
    await prisma.payrollRun.deleteMany({ where: { companyId: A } });
    await prisma.employee.update({ where: { id: employee }, data: { salarioDiario: 500, salarioDiarioIntegrado: 525, puesto: null } });
    conv = (await prisma.chatConversation.create({ data: { companyId: A, userId: U, visibility: "COMPANY", title: "Synthetic documents" } })).id;
    await prisma.chatMessage.create({ data: { conversationId: conv, role: "user", content: "Prepare the synthetic document" } });
  });
  it("retrieves historical invoices in their original currency without reissuing them", async () => {
    const old = await prisma.invoice.create({ data: { companyId: A, tipo: "INGRESO", fecha: new Date("2025-01-10"), formaPago: "03", metodoPago: "PUE", usoCfdi: "G03", subtotal: 100, total: 100, moneda: "USD", status: "STAMPED", uuid: randomUUID(), contraparteNombre: "Historical receiver", contraparteRfc: "HIS250110AA1", rawXml: "synthetic-xml" } });
    const view = await readDocument({ kind: "factura", companyId: A, id: old.id });
    expect(view).toMatchObject({ currency: "USD", total: 100, stampable: false });
    const search = JSON.parse(await executeDocumentTool("buscar_documentos", { kind: "factura", q: "Historical receiver" }, A, { userId: U, conversationId: conv }));
    expect(search.results).toContainEqual(expect.objectContaining({ id: old.id, currency: "USD" }));
    expect(mock.pacStamp).not.toHaveBeenCalled();
  });

  it("prepares once, retrieves the durable draft, and never stamps during preparation", async () => {
    const ref = await draft();
    expect(await draft()).toEqual(ref);
    expect(mock.pacCreate).toHaveBeenCalledOnce();
    expect(mock.pacStamp).not.toHaveBeenCalled();
    const view = await readDocument(ref);
    expect(view).toMatchObject({ total: 116, stampable: true, status: "PENDIENTE" });
    expect(view.downloads[0].href).toContain("/pdf?companyId=");
    const search = JSON.parse(await executeDocumentTool("buscar_documentos", { kind: "prefactura", q: "SYNTHETIC RECEIVER" }, A, { userId: U, conversationId: conv }));
    expect(search.documents).toContainEqual(ref);
    expect(mock.pacCreate).toHaveBeenCalledOnce();
  });
  it("anchors first-turn legacy preparation and automatic follow-ups to one human request", async () => {
    const fresh = await prisma.chatConversation.create({ data: { companyId: A, userId: U } });
    const messageInput = { conversationId: fresh.id, userId: U, requestId: "synthetic-request-id", content: "Prepare invoice" };
    const userMessageId = await persistChatUserTurn(messageInput);
    expect(await persistChatUserTurn(messageInput)).toBe(userMessageId);
    await expect(persistChatUserTurn({ ...messageInput, content: "Different request" })).rejects.toThrow(/otro contenido/);
    const first = JSON.parse(await executeDocumentTool("preparar_prefactura", input(), A, { userId: U, conversationId: fresh.id, userMessageId, inApp: true }));
    expect(first.error).toBeUndefined();
    const followup = await persistChatUserTurn({ ...messageInput, requestId: "automatic-followup", content: "Continue", meta: { seguimiento: true } });
    const resumed = JSON.parse(await executeDocumentTool("preparar_prefactura", input(), A, { userId: U, conversationId: fresh.id, userMessageId: followup, inApp: true }));
    expect(resumed.documents).toEqual(first.documents);
    expect(mock.pacCreate).toHaveBeenCalledOnce();
    expect(mock.pacStamp).not.toHaveBeenCalled();
  });

  it("blocks foreign documents, foreign conversations and viewer writes before PAC calls", async () => {
    const ref = await draft();
    const foreign = await prisma.chatConversation.create({ data: { companyId: B, userId: U } });
    for (const [name, args, companyId, context] of [
      ["mostrar_documento", { kind: "prefactura", id: ref.id }, B, { userId: U }],
      ["mostrar_documento", { kind: "prefactura", id: ref.id }, A, { userId: U, conversationId: foreign.id }],
      ["preparar_prefactura", input(), A, { userId: V, conversationId: conv, inApp: true }],
    ] as const) expect(JSON.parse(await executeDocumentTool(name, args, companyId, context)).error).toBeTruthy();
    mock.userId = V;
    const read = await GET(new Request(`https://app.test/api/ai/documentos?companyId=${A}&kind=prefactura&id=${ref.id}&conversationId=${conv}`));
    expect((await read.json()).document.stampable).toBe(false);
    const response = await POST(new Request("https://app.test/api/ai/documentos", { method: "POST", body: JSON.stringify({ action: "review", ref, conversationId: conv }) }));
    expect(response.status).toBe(403);
    expect(mock.pacStamp).not.toHaveBeenCalled();
  });
  it("accepts the public Host behind a proxy and rejects a foreign browser origin", async () => {
    const ref = await draft();
    const body = JSON.stringify({ action: "review", ref, conversationId: conv });
    const allowed = await POST(new Request("http://0.0.0.0:3219/api/ai/documentos", { method: "POST", headers: { Host: "app.test", Origin: "https://app.test", "sec-fetch-site": "same-origin" }, body }));
    expect(allowed.status).toBe(200);
    const denied = await POST(new Request("http://0.0.0.0:3219/api/ai/documentos", { method: "POST", headers: { Host: "app.test", Origin: "https://other.test", "sec-fetch-site": "cross-site" }, body }));
    expect(denied.status).toBe(403);
    expect(mock.pacStamp).not.toHaveBeenCalled();
  });
  it("asks for a global period instead of silently invoicing public sales in the current month", async () => {
    const generic = await prisma.customer.create({ data: { companyId: A, razonSocial: "PUBLICO EN GENERAL", rfc: "XAXX010101000", regimenFiscal: "616", codigoPostal: "06600", facturapiId: "synthetic-public" } });
    const result = JSON.parse(await executeDocumentTool("preparar_prefactura", { ...input(), customer_id: generic.id }, A, { userId: U, conversationId: conv, inApp: true }));
    expect(result.error).toMatch(/global requiere/);
    expect(mock.pacCreate).not.toHaveBeenCalled();
    const explicit = JSON.parse(await executeDocumentTool("preparar_prefactura", { ...input(), customer_id: generic.id, global: { periodicity: "month", months: "09", year: 2026 } }, A, { userId: U, conversationId: conv, inApp: true }));
    expect(explicit.error).toBeUndefined();
    const review = await reviewDocument(explicit.documents[0], U, conv);
    expect(review.payloads[0].payload.global).toEqual({ periodicity: "month", months: "09", year: 2026 });
    expect(mock.pacStamp).not.toHaveBeenCalled();
  });

  it("refuses a stale reviewed draft without calling PAC", async () => {
    const ref = await draft();
    const review = await reviewDocument(ref, U, conv);
    await prisma.facturaBorrador.update({ where: { id: ref.id }, data: { total: 120 } });
    await expect(confirmDocumentStamp(ref, review.token, U, conv, req())).rejects.toThrow(/cambió/);
    expect(mock.pacStamp).not.toHaveBeenCalled();
  });
  it("stamps once under concurrent clicks and persists the real UUID handoff in chat", async () => {
    const ref = await draft();
    const review = await reviewDocument(ref, U, conv);
    const results = await Promise.allSettled([confirmDocumentStamp(ref, review.token, U, conv, req()), confirmDocumentStamp(ref, review.token, U, conv, req())]);
    expect(results.some((r) => r.status === "fulfilled" && r.value.ok)).toBe(true);
    expect(mock.pacStamp).toHaveBeenCalledOnce();
    const replay = await confirmDocumentStamp(ref, review.token, U, conv, req());
    expect(replay.ok).toBe(true);
    expect(mock.pacStamp).toHaveBeenCalledOnce();
    const card = await readDocument(replay.documents[0]);
    expect(card.uuid).toMatch(/^[a-f0-9-]{36}$/i);
    expect(card.downloads.map((d) => d.label)).toEqual(["XML", "PDF"]);
    expect(await prisma.chatMessage.count({ where: { conversationId: conv, role: "assistant" } })).toBe(1);
  });
  it("shares the invoice claim with direct issuance and blocks unknown provider outcomes", async () => {
    const ref = await draft();
    const row = await cargarPrefactura(ref.id!);
    mock.pacStamp.mockRejectedValue(new Error("Synthetic network timeout after request"));
    const results = await Promise.allSettled([timbrarPrefactura(row!, { id: U }, req()), timbrarPrefactura(row!, { id: U }, req())]);
    expect(results.some((r) => r.status === "rejected")).toBe(true);
    expect(mock.pacStamp).toHaveBeenCalledOnce();
    expect((await readDocument(ref)).stampable).toBe(false);
    expect((await cargarPrefactura(ref.id!))?.status).toBe("REVISAR_TIMBRADO");
  });
  it("prepares payroll through the agent tool once and returns a durable document card reference", async () => {
    const args = { employee_ids: [employee], periodo_inicio: "2026-09-01", periodo_fin: "2026-09-15", fecha_pago: "2026-09-15", dias_pagados: 15 };
    const context = { userId: U, conversationId: conv, inApp: true };
    const first = JSON.parse(await executeDocumentTool("preparar_nomina", args, A, context));
    expect(first.error).toBeUndefined();
    expect(first.documents).toEqual([{ kind: "nomina", companyId: A, id: expect.any(String) }]);
    const again = JSON.parse(await executeDocumentTool("preparar_nomina", args, A, context));
    expect(again.documents).toEqual(first.documents);
    expect(await prisma.payrollRun.count({ where: { companyId: A } })).toBe(1);
    expect(await prisma.stagedAction.count({ where: { companyId: A, type: "mochi_document_prepare", status: "DONE", payload: { path: ["conversationId"], equals: conv } } })).toBe(1);
    expect(mock.payrollStamp).not.toHaveBeenCalled();
  });

  it("atomically rejects overlapping chat payroll preparations", async () => {
    const results = await Promise.all([createPayrollRun(payrollInput(), { preventEmployeeOverlap: true }), createPayrollRun(payrollInput(), { preventEmployeeOverlap: true })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.payrollRun.count({ where: { companyId: A } })).toBe(1);
    expect(mock.payrollStamp).not.toHaveBeenCalled();
  });
  it("shows final payroll fields, blocks changed identity, then stamps and retrieves the receipt", async () => {
    const run = await createPayrollRun(payrollInput());
    const ref = { kind: "nomina" as const, companyId: A, id: run.runId! };
    const review = await reviewDocument(ref, U, conv);
    expect(review.payloads).toHaveLength(1);
    expect(review.payloads[0].payload).toMatchObject({ customer: { tax_id: "SYN010101AA12" }, type: "N" });
    expect(mock.payrollStamp).not.toHaveBeenCalled();
    await prisma.employee.update({ where: { id: employee }, data: { puesto: "Changed after review" } });
    await expect(confirmDocumentStamp(ref, review.token, U, conv, req())).rejects.toThrow(/cambió/);
    expect(mock.payrollStamp).not.toHaveBeenCalled();
    const current = await reviewDocument(ref, U, conv);
    const result = await confirmDocumentStamp(ref, current.token, U, conv, req());
    expect(result.ok).toBe(true);
    expect(mock.payrollStamp).toHaveBeenCalledOnce();
    const receipt = (await readDocument(ref)).receipts![0];
    const old = await readDocument({ kind: "recibo_nomina", companyId: A, id: receipt.id });
    expect(old.uuid?.toLowerCase()).toBe(receipt.uuid?.toLowerCase());
    expect(old.downloads).toHaveLength(2);
    expect(mock.payrollStamp).toHaveBeenCalledOnce();
  });
  it("reviews only the remaining receipts and amount in a partially stamped payroll", async () => {
    const second = await prisma.employee.create({ data: { companyId: A, nombre: "Second", apellidoPaterno: "Synthetic", rfc: `SYN${randomUUID().slice(0, 10)}`, curp: "SYN010101HDFXXX01", nss: "12345678902", codigoPostal: "06600", fechaIngreso: new Date("2025-01-01"), tipoContrato: "01", tipoJornada: "01", salarioDiario: 600, salarioDiarioIntegrado: 625, periodicidadPago: "04" } });
    const run = await createPayrollRun({ ...payrollInput(), employeeIds: [employee, second.id] });
    const rows = await prisma.payrollItem.findMany({ where: { payrollRunId: run.runId! } });
    const done = rows.find((r) => r.employeeId === employee)!;
    const pending = rows.find((r) => r.employeeId === second.id)!;
    await prisma.payrollItem.update({ where: { id: done.id }, data: { cfdiUuid: randomUUID() } });
    const ref = { kind: "nomina" as const, companyId: A, id: run.runId! };
    const review = await reviewDocument(ref, U, conv);
    expect(review.payloads.map((r) => r.id)).toEqual([pending.id]);
    expect(review.amountToStamp).toBe(Number(pending.netoAPagar));
    expect(review.amountToStamp).toBeLessThan(review.view.total!);
    expect((await confirmDocumentStamp(ref, review.token, U, conv, req())).ok).toBe(true);
    expect(mock.payrollStamp).toHaveBeenCalledOnce();
  });

  it("guards the final PAC payload against edits after preview and blocks ambiguous payroll retries", async () => {
    const run = await createPayrollRun(payrollInput());
    const item = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: run.runId! } });
    const preview = await previewRecibo(A, item.id);
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error(preview.error);
    const payload = await emitNominaCfdi(preview.stampInput, { preview: true });
    await prisma.employee.update({ where: { id: employee }, data: { puesto: "Different receiver fields" } });
    const stale = await emitNominaCfdi(preview.stampInput, { expectedPayloadHash: payload.preview!.hash });
    expect(stale.ok).toBe(false);
    expect(mock.payrollStamp).not.toHaveBeenCalled();
    mock.payrollStamp.mockRejectedValue(new Error("Synthetic timeout"));
    const attempt = await stampPayrollRun(run.runId!);
    expect(attempt.ok).toBe(false);
    expect(mock.payrollStamp).toHaveBeenCalledOnce();
    const retry = await stampPayrollRun(run.runId!);
    expect(retry.errors.join(" ")).toMatch(/no verificado/);
    expect(mock.payrollStamp).toHaveBeenCalledOnce();
  });
});
