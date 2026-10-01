import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { evidenceHash, readDeductionReviewHistory, readDeductionReviewWorkspace, saveDeductionReview } from "./deduction-review";
import { readRegimenDeductionEvidence } from "./regimen-deduction-evidence";
import { readRegimenIncomeEvidence } from "./regimen-income-evidence";
import { reviewWriteSchema, type ReviewScope } from "./deduction-review-contract";
import { REP_XML_MAX_BYTES } from "./rep-payment-evidence";
import { repFixture, repXml } from "@/test/fiscal/fixtures/rep-payment-v1";

describe.skipIf(process.env.DB_TESTS_SKIP === "1")("FISC-002P real PostgreSQL source comparison", () => {
  const companies: string[] = [];
  const actor = { id: "synthetic-rep-reviewer", email: "reviewer@synthetic.invalid" };
  let scope: ReviewScope, invoiceId: string, repId: string;
  async function company(rfc = repFixture.companyRfc) {
    const row = await prisma.company.create({ data: { rfc, razonSocial: "Synthetic REP evidence only", codigoPostal: "06600", regimenFiscal: "612" } });
    companies.push(row.id); return row.id;
  }
  beforeEach(async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No external requests in fiscal tests"));
    scope = { companyId: await company(), year: 2026, month: 9, periodo: "2026-09", page: 1 };
    invoiceId = (await prisma.invoice.create({ data: { companyId: scope.companyId, uuid: repFixture.parentUuid,
      contraparteRfc: repFixture.supplierRfc, tipo: "EGRESO", tipoSat: "I", status: "STAMPED", fecha: new Date("2026-09-01T12:00:00Z"),
      formaPago: "99", metodoPago: "PPD", usoCfdi: "G03", moneda: "MXN", naturaleza: "GASTO", naturalezaManual: true, subtotal: "100", total: "116" } })).id;
    repId = (await prisma.invoice.create({ data: { companyId: scope.companyId, uuid: repFixture.repUuid, tipo: "PAGO", tipoSat: "P", status: "STAMPED",
      fecha: new Date("2026-10-01T12:00:00Z"), formaPago: "99", metodoPago: "PUE", usoCfdi: "CP01", moneda: "XXX", subtotal: "0", total: "0", rawXml: repXml(),
      doctosRelacionados: { create: { parentUuid: repFixture.parentUuid, impPagado: repFixture.paid, fechaPago: new Date(`${repFixture.date}Z`), numParcialidad: 1 } } } })).id;
  });
  afterEach(async () => {
    try {
      expect(globalThis.fetch).not.toHaveBeenCalled();
      await prisma.auditLog.deleteMany({ where: { companyId: { in: companies } } });
      await prisma.company.deleteMany({ where: { id: { in: companies } } }); companies.length = 0;
    } finally { vi.restoreAllMocks(); }
  });
  afterAll(async () => { await prisma.$disconnect(); });
  async function body() {
    const workspace = await readDeductionReviewWorkspace(scope);
    return reviewWriteSchema.parse({ kind: "review", invoiceId, source: "PPD_REP", regimenCode: "612", decision: "DOCUMENTADA", expectedRevision: 0,
      evidenceHash: workspace.evidenceHash, requestId: randomUUID(), reason: "Cotejo sintético del REP; no aprobación de un importe fiscal.", references: ["Papel sintético 42"], acknowledged: true });
  }

  it("coteja the correct stored XML by FechaPago, not the later REP issue date", async () => {
    const workspace = await readDeductionReviewWorkspace(scope), row = workspace.renglones[0];
    expect(row.evidenciaPago).toMatchObject({ estado: "REP_COTEJADO", totalRelaciones: 1, relacionesEnPeriodo: 1, pendientes: 0,
      comprobacionBancaria: false, deduccionAutorizadaCentavos: null, pagos: [{ repInvoiceId: repId, xmlHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        cotejo: { estado: "COTEJADO", fechaPago: repFixture.date, formaDePagoP: "03", impPagado: "58.000000" } }] });
    expect(row.motivos).toContain("PAYMENT_METHOD_REVIEW"); expect(row.motivos).not.toContain("PPD_PAYMENT_METHOD_UNAVAILABLE");
    expect(workspace).toMatchObject({ deduccionAutorizadaCentavos: null, usadaEnCalculoAutomatico: false });
    expect(JSON.stringify(workspace)).not.toContain("<cfdi:");
    expect((await readDeductionReviewWorkspace({ ...scope, month: 10, periodo: "2026-10" })).renglones).toHaveLength(0);
  });
  it("retains the compared facts and hash in a saved review snapshot", async () => {
    await saveDeductionReview(scope, await body(), actor);
    expect((await readDeductionReviewHistory(scope)).revisiones[0].snapshot).toMatchObject({ row: {
      evidenciaPago: { estado: "REP_COTEJADO", pagos: [{ xmlHash: expect.stringMatching(/^[a-f0-9]{64}$/), cotejo: { formaDePagoP: "03" } }] } } });
    expect(await prisma.taxDeclaration.count({ where: { companyId: scope.companyId } })).toBe(0);
  });
  it("marks saved reviews stale when only the XML changes and rejects the old token", async () => {
    const input = await body(); await saveDeductionReview(scope, input, actor);
    await prisma.invoice.update({ where: { id: repId }, data: { rawXml: repXml({ method: "28" }) } });
    const workspace = await readDeductionReviewWorkspace(scope);
    expect(workspace.renglones[0].review?.estado).toBe("DESACTUALIZADA");
    expect(workspace.renglones[0].evidenciaPago.pagos[0].cotejo).toMatchObject({ estado: "COTEJADO", formaDePagoP: "28" });
    await expect(saveDeductionReview(scope, { ...input, expectedRevision: 1, requestId: randomUUID() }, actor)).rejects.toMatchObject({ code: "EVIDENCE_CHANGED" });
    expect(await prisma.fiscalDeductionReview.count({ where: { companyId: scope.companyId } })).toBe(1);
  });
  it("never substitutes the parent's payment method for missing XML", async () => {
    await prisma.invoice.update({ where: { id: invoiceId }, data: { formaPago: "03" } });
    await prisma.invoice.update({ where: { id: repId }, data: { rawXml: null } });
    const row = (await readDeductionReviewWorkspace(scope)).renglones[0];
    expect(row.evidenciaPago).toMatchObject({ estado: "REP_PENDIENTE", pagos: [{ cotejo: { motivo: "XML_MISSING" } }] });
    expect(row.motivos).toContain("PPD_PAYMENT_METHOD_UNAVAILABLE");
  });
  it("keeps changed amount, provider identity and currency disagreements visible", async () => {
    for (const [patch, reason] of [[{ paid: "57" }, "PAYMENT_MISMATCH"], [{ supplierRfc: "BBB010101BBB" }, "IDENTITY_MISMATCH"], [{ currency: "USD" }, "CURRENCY_REVIEW"]] as const) {
      await prisma.invoice.update({ where: { id: repId }, data: { rawXml: repXml(patch) } });
      expect((await readDeductionReviewWorkspace(scope)).renglones[0].evidenciaPago).toMatchObject({ estado: "REP_PENDIENTE", pagos: [{ cotejo: { motivo: reason } }] });
    }
  });
  it("does not borrow another company's valid XML with the same REP UUID", async () => {
    await prisma.invoice.update({ where: { id: repId }, data: { rawXml: null } });
    await prisma.invoice.create({ data: { companyId: await company("PAGO260101DEF"), uuid: repFixture.repUuid, tipo: "PAGO", tipoSat: "P", status: "STAMPED",
      fecha: new Date("2026-09-10T12:00:00Z"), formaPago: "99", metodoPago: "PUE", usoCfdi: "CP01", moneda: "XXX", subtotal: "0", total: "0", rawXml: repXml() } });
    expect((await readDeductionReviewWorkspace(scope)).renglones[0].evidenciaPago.pagos[0].cotejo).toMatchObject({ motivo: "XML_MISSING" });
  });
  it("fails closed on an oversized source without returning XML or fabricated payment facts", async () => {
    await prisma.invoice.update({ where: { id: repId }, data: { rawXml: repXml({ note: `<!--${"a".repeat(REP_XML_MAX_BYTES)}-->` }) } });
    const workspace = await readDeductionReviewWorkspace(scope);
    expect(workspace.renglones[0].evidenciaPago).toMatchObject({ estado: "REP_PENDIENTE", pagos: [{ xmlHash: null, cotejo: { motivo: "XML_LIMIT" } }] });
    expect(JSON.stringify(workspace).length).toBeLessThan(20_000);
  });
  it("does not mark a cancelled REP as current payment evidence", async () => {
    await prisma.invoice.update({ where: { id: repId }, data: { status: "CANCELLED" } });
    expect((await readDeductionReviewWorkspace(scope)).renglones).toHaveLength(0);
  });
  it("checks the entire imported history, including sources outside the selected month", async () => {
    const nextUuid = randomUUID().toUpperCase();
    const next = await prisma.invoice.create({ data: { companyId: scope.companyId, uuid: nextUuid, tipo: "PAGO", tipoSat: "P", status: "STAMPED",
      fecha: new Date("2026-10-10T12:00:00Z"), formaPago: "99", metodoPago: "PUE", usoCfdi: "CP01", moneda: "XXX", subtotal: "0", total: "0",
      doctosRelacionados: { create: { parentUuid: repFixture.parentUuid, impPagado: "58", fechaPago: new Date("2026-10-10T12:00:00Z"), numParcialidad: 2 } } } });
    const before = await readDeductionReviewWorkspace(scope);
    expect(before.renglones[0].evidenciaPago).toMatchObject({ estado: "REP_PENDIENTE", totalRelaciones: 2, relacionesEnPeriodo: 1, pendientes: 1 });
    expect(before.renglones[0].evidenciaPago.pagos.find((p) => !p.enPeriodo)?.cotejo).toMatchObject({ motivo: "XML_MISSING" });
    await prisma.invoice.update({ where: { id: next.id }, data: { rawXml: repXml({ repUuid: nextUuid, date: "2026-10-10T12:00:00", installment: "2", before: "58", after: "0" }) } });
    const after = await readDeductionReviewWorkspace(scope);
    expect(after.renglones[0].evidenciaPago).toMatchObject({ estado: "REP_COTEJADO", totalRelaciones: 2, pendientes: 0 });
    expect(after.evidenceHash).not.toBe(before.evidenceHash);
  });
  it("does not change existing income/deduction documentary numbers or make PUE payment proof", async () => {
    const before = await readRegimenDeductionEvidence(scope.companyId, 2026, 9);
    await prisma.invoice.update({ where: { id: repId }, data: { rawXml: repXml({ method: "99" }) } });
    expect(await readRegimenDeductionEvidence(scope.companyId, 2026, 9)).toEqual(before);
    expect(await readRegimenIncomeEvidence(scope.companyId, 2026, 9)).toMatchObject({ estado: "SIN_EVIDENCIA", totales: null });
    await prisma.invoice.update({ where: { id: invoiceId }, data: { metodoPago: "PUE" } });
    const row = (await readDeductionReviewWorkspace(scope)).renglones.find((r) => r.source === "PUE_DOCUMENTADO")!;
    expect(row.evidenciaPago).toMatchObject({ estado: "PUE_SIN_ACREDITAR", comprobacionBancaria: false, pagos: [] });
    expect(row.motivos).toContain("PUE_PAYMENT_EVIDENCE_REQUIRED");
  });
  it("preserves an unchanged reported option from the pre-payment-check context version", async () => {
    await prisma.company.update({ where: { id: scope.companyId }, data: { regimenFiscal: "606" } });
    await prisma.fiscalRegimeElection.create({ data: { companyId: scope.companyId, year: 2026, regimenCode: "606", revision: 1,
      choice: "COMPROBADAS", effectiveFrom: "2026-01", effectiveTo: "2026-12", reason: "Prior synthetic option observation.", references: ["Synthetic docket"],
      reviewedById: actor.id, requestId: randomUUID(), requestHash: "0".repeat(64),
      contextHash: evidenceHash({ companyId: scope.companyId, year: 2026,
        company: { rfc: repFixture.companyRfc, regimenFiscal: "606", regimenes: [] }, version: "2026-10-01.1" }) } });
    expect((await readDeductionReviewWorkspace(scope)).elecciones.find((e) => e.regimenCode === "606")?.registro?.estado).toBe("REGISTRADA");
    await prisma.invoice.update({ where: { id: repId }, data: { rawXml: repXml({ method: "28" }) } });
    expect((await readDeductionReviewWorkspace(scope)).elecciones.find((e) => e.regimenCode === "606")?.registro?.estado).toBe("REGISTRADA");
  });
  it("fingerprints sources beyond the 25-relation preview and prioritizes their pending reasons", async () => {
    const extraIds: string[] = [];
    for (let index = 0; index < 26; index++) {
      const repUuid = randomUUID().toUpperCase();
      const row = await prisma.invoice.create({ data: { companyId: scope.companyId, uuid: repUuid, tipo: "PAGO", tipoSat: "P", status: "STAMPED",
        fecha: new Date(`${repFixture.date}Z`), formaPago: "99", metodoPago: "PUE", usoCfdi: "CP01", moneda: "XXX", subtotal: "0", total: "0",
        rawXml: repXml({ repUuid, paid: "1", before: String(58 - index), after: String(57 - index), installment: String(index + 2) }),
        doctosRelacionados: { create: { parentUuid: repFixture.parentUuid, impPagado: "1", fechaPago: new Date(`${repFixture.date}Z`), numParcialidad: index + 2 } } } });
      extraIds.push(row.id);
    }
    const before = await readDeductionReviewWorkspace(scope), evidence = before.renglones[0].evidenciaPago;
    expect(evidence).toMatchObject({ estado: "REP_COTEJADO", totalRelaciones: 27, vistaLimitada: true });
    expect(evidence.pagos).toHaveLength(25);
    const hidden = extraIds.find((id) => !evidence.pagos.some((p) => p.repInvoiceId === id))!;
    expect(hidden).toBeTruthy();
    await prisma.invoice.update({ where: { id: hidden }, data: { rawXml: null } });
    const after = await readDeductionReviewWorkspace(scope);
    expect(after.evidenceHash).not.toBe(before.evidenceHash);
    expect(after.renglones[0].evidenciaPago).toMatchObject({ estado: "REP_PENDIENTE", pendientes: 1 });
    expect(after.renglones[0].evidenciaPago.pagos[0]).toMatchObject({ repInvoiceId: hidden, cotejo: { motivo: "XML_MISSING" } });
  });
});
