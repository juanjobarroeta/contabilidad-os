import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { readDeductionReviewHistory, readDeductionReviewWorkspace, saveDeductionReview } from "./deduction-review";
import { reviewWriteSchema, type ReviewScope, type ReviewWrite } from "./deduction-review-contract";
import { readRegimenDeductionEvidence } from "./regimen-deduction-evidence";
import { assertMonthlyCompanyCalculationSupported } from "./regimen-capabilities";

describe.skipIf(process.env.DB_TESTS_SKIP === "1")("FISC-002O immutable reviews on real PostgreSQL", () => {
  let scope: ReviewScope;
  let invoiceId: string;
  const companyIds: string[] = [];
  const actor = { id: "synthetic-accountant", email: "accountant@synthetic.invalid" };
  let sequence = 0;
  async function company() {
    const row = await prisma.company.create({ data: { rfc: `FISO260101${String(++sequence).padStart(3, "0")}`,
      razonSocial: "Synthetic deduction review only", codigoPostal: "06600", regimenFiscal: "612" } });
    companyIds.push(row.id); return row.id;
  }
  async function review(patch: Record<string, unknown> = {}): Promise<ReviewWrite> {
    const data = await readDeductionReviewWorkspace(scope);
    return reviewWriteSchema.parse({ kind: "review", invoiceId, source: "PUE_DOCUMENTADO", regimenCode: "612", decision: "DOCUMENTADA",
      expectedRevision: 0, evidenceHash: data.evidenceHash, requestId: randomUUID(), reason: "Revisión sintética del expediente; no aprobación fiscal.", references: ["Papel de trabajo sintético 42"], acknowledged: true, ...patch });
  }
  async function election(patch: Record<string, unknown> = {}): Promise<ReviewWrite> {
    const data = await readDeductionReviewWorkspace(scope);
    return reviewWriteSchema.parse({ kind: "election", regimenCode: "606", choice: "COMPROBADAS", effectiveFrom: "2026-01", effectiveTo: "2026-12",
      expectedRevision: 0, evidenceHash: data.evidenceHash, requestId: randomUUID(), reason: "Registro sintético de opción informada; requiere validación.", references: ["Acuse sintético del expediente"], acknowledged: true, ...patch });
  }
  beforeEach(async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("External requests forbidden in synthetic fiscal tests"));
    scope = { companyId: await company(), year: 2026, month: 9, periodo: "2026-09", page: 1 };
    invoiceId = (await prisma.invoice.create({ data: { companyId: scope.companyId, uuid: randomUUID(), tipo: "EGRESO", tipoSat: "I", status: "STAMPED",
      fecha: new Date("2026-09-10T12:00:00Z"), formaPago: "03", metodoPago: "PUE", usoCfdi: "G03", moneda: "MXN",
      naturaleza: "GASTO", naturalezaManual: true, subtotal: "100", descuento: "0", total: "116" } })).id;
  });
  afterEach(async () => {
    try {
      expect(globalThis.fetch).not.toHaveBeenCalled();
      await prisma.auditLog.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
      companyIds.length = 0;
    } finally { vi.restoreAllMocks(); }
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it("persists reviewer, references, snapshot and audit atomically without authorizing a deduction", async () => {
    const input = await review();
    expect(await saveDeductionReview(scope, input, actor)).toMatchObject({ revision: 1, usadaEnCalculoAutomatico: false });
    const data = await readDeductionReviewWorkspace(scope);
    expect(data).toMatchObject({ deduccionAutorizadaCentavos: null, usadaEnCalculoAutomatico: false, resumen: { revisionesVigentes: 1 } });
    expect(data.renglones[0].review).toMatchObject({ revision: 1, estado: "VIGENTE", reviewedById: actor.id, references: input.references });
    expect(await prisma.auditLog.count({ where: { companyId: scope.companyId, accion: "fiscal.documentar-revision" } })).toBe(1);
    expect((await readDeductionReviewHistory(scope)).revisiones[0].snapshot).toMatchObject({ periodo: "2026-09", row: { baseCentavos: 10000 } });
    expect(await readRegimenDeductionEvidence(scope.companyId, 2026, 9)).toMatchObject({ deduccionAutorizadaCentavos: null, estado: "PENDIENTE" });
    expect(await prisma.taxDeclaration.count({ where: { companyId: scope.companyId } })).toBe(0);
  });
  it("replays an identical request without another revision or audit, even after source changes", async () => {
    const input = await review(); await saveDeductionReview(scope, input, actor);
    await prisma.invoice.update({ where: { id: invoiceId }, data: { naturaleza: "INVERSION" } });
    expect(await saveDeductionReview(scope, input, actor)).toMatchObject({ revision: 1, replayed: true });
    expect(await prisma.fiscalDeductionReview.count({ where: { companyId: scope.companyId } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { companyId: scope.companyId } })).toBe(1);
    expect((await readDeductionReviewWorkspace(scope)).renglones[0].review?.estado).toBe("DESACTUALIZADA");
  });
  it("rejects reuse of an idempotency key for a different decision or actor", async () => {
    const input = await review(); await saveDeductionReview(scope, input, actor);
    await expect(saveDeductionReview(scope, { ...input, reason: "Otro criterio cambiado después del primer envío." }, actor)).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    await expect(saveDeductionReview(scope, input, { id: "other", email: null })).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  });
  it("rejects stale evidence before saving and preserves the original revision", async () => {
    const input = await review(); await saveDeductionReview(scope, input, actor);
    await prisma.invoice.update({ where: { id: invoiceId }, data: { subtotal: "100.004999", total: "116.004999" } });
    await expect(saveDeductionReview(scope, { ...input, requestId: randomUUID(), expectedRevision: 1 }, actor)).rejects.toMatchObject({ code: "EVIDENCE_CHANGED" });
    expect((await readDeductionReviewWorkspace(scope)).resumen.revisionesDesactualizadas).toBe(1);
  });
  it("rejects stale review revisions without overwriting history", async () => {
    await saveDeductionReview(scope, await review(), actor);
    await expect(saveDeductionReview(scope, await review(), actor)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await saveDeductionReview(scope, await review({ expectedRevision: 1, decision: "NO_PROPONER" }), actor);
    expect((await readDeductionReviewHistory(scope)).revisiones.map((r) => r.revision)).toEqual([2, 1]);
  });
  it("allows only one concurrent writer for the same revision", async () => {
    const input = await review();
    const results = await Promise.allSettled([saveDeductionReview(scope, input, actor), saveDeductionReview(scope, { ...input, requestId: randomUUID() }, actor)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await prisma.fiscalDeductionReview.count({ where: { companyId: scope.companyId } })).toBe(1);
  });
  it("keeps histories and source IDs isolated across companies", async () => {
    await saveDeductionReview(scope, await review(), actor);
    const otherScope = { ...scope, companyId: await company() };
    const other = await readDeductionReviewWorkspace(otherScope);
    await expect(saveDeductionReview(otherScope, await review({ evidenceHash: other.evidenceHash }), actor)).rejects.toMatchObject({ code: "DOCUMENTARY_REVIEW_REQUIRED" });
    expect((await readDeductionReviewHistory(otherScope)).revisiones).toEqual([]);
    expect(other.renglones).toEqual([]);
  });
  it("reopens a cancelled source without erasing the historical decision", async () => {
    await saveDeductionReview(scope, await review(), actor);
    await prisma.invoice.update({ where: { id: invoiceId }, data: { status: "CANCELLED" } });
    expect((await readDeductionReviewWorkspace(scope)).resumen.revisionesSinRenglon).toBe(1);
    await saveDeductionReview(scope, await review({ expectedRevision: 1, decision: "PENDIENTE", references: [] }), actor);
    const history = await readDeductionReviewHistory(scope);
    expect(history.revisiones.map((row) => row.decision)).toEqual(["PENDIENTE", "DOCUMENTADA"]);
  });
  it("blocks a new recorded review while documentary prerequisites are incomplete", async () => {
    await prisma.invoice.update({ where: { id: invoiceId }, data: { moneda: "USD" } });
    expect((await readDeductionReviewWorkspace(scope)).puedeDocumentar).toBe(false);
    await expect(saveDeductionReview(scope, await review(), actor)).rejects.toMatchObject({ code: "DOCUMENTARY_REVIEW_REQUIRED" });
  });
  it("records an effective-period rental observation and invalidates earlier review snapshots", async () => {
    await prisma.company.update({ where: { id: scope.companyId }, data: { regimenFiscal: "606" } });
    await saveDeductionReview(scope, await review({ regimenCode: "606" }), actor);
    await saveDeductionReview(scope, await election({ choice: "OPCIONAL_35", effectiveFrom: "2026-09", effectiveTo: "2026-12" }), actor);
    const data = await readDeductionReviewWorkspace(scope);
    expect(data.elecciones.find((e) => e.regimenCode === "606")?.registro).toMatchObject({ choice: "OPCIONAL_35", estado: "REGISTRADA" });
    expect(data.resumen.revisionesDesactualizadas).toBe(1);
    const earlier = await readDeductionReviewWorkspace({ ...scope, month: 8, periodo: "2026-08" });
    expect(earlier.elecciones.find((e) => e.regimenCode === "606")?.registro?.estado).toBe("FUERA_DE_VIGENCIA");
    expect(data.deduccionAutorizadaCentavos).toBeNull();
  });
  it("never guesses an election from an engine default, and rejects incompatible taxpayer types", async () => {
    const input = await election();
    await expect(saveDeductionReview(scope, input, actor)).rejects.toMatchObject({ code: "ELECTION_NOT_APPLICABLE" });
    await prisma.company.update({ where: { id: scope.companyId }, data: { rfc: "FIS260101001", regimenFiscal: "606" } });
    await expect(saveDeductionReview(scope, await election(), actor)).rejects.toMatchObject({ code: "ELECTION_NOT_APPLICABLE" });
  });
  it("does not extrapolate capture into another year or election coverage", async () => {
    await expect(saveDeductionReview({ ...scope, year: 2025, periodo: "2025-09" }, await review(), actor)).rejects.toMatchObject({ code: "RULE_PERIOD_REVIEW" });
    await prisma.company.update({ where: { id: scope.companyId }, data: { regimenFiscal: "606" } });
    await expect(saveDeductionReview(scope, await election({ effectiveTo: "2027-12" }), actor)).rejects.toMatchObject({ code: "ELECTION_PERIOD" });
    await expect(saveDeductionReview(scope, await election({ effectiveFrom: "2026-10" }), actor)).rejects.toMatchObject({ code: "ELECTION_PERIOD" });
  });
  it("marks election evidence stale when taxpayer/regime evidence changes", async () => {
    await prisma.company.update({ where: { id: scope.companyId }, data: { regimenFiscal: "606" } });
    await saveDeductionReview(scope, await election(), actor);
    await prisma.companyRegimen.create({ data: { companyId: scope.companyId, code: "606", label: "Arrendamiento", since: new Date("2026-09-01Z") } });
    expect((await readDeductionReviewWorkspace(scope)).elecciones.find((e) => e.regimenCode === "606")?.registro?.estado).toBe("DESACTUALIZADA");
  });
  it("preserves the existing mixed-regime calculation prohibition", async () => {
    await saveDeductionReview(scope, await review(), actor);
    expect(() => assertMonthlyCompanyCalculationSupported({ regimenFiscal: "612", regimenes: ["612", "606"], tipoPersona: "PF" })).toThrow();
  });
  it("records platform observations without treating them as deduction authorization", async () => {
    await prisma.company.update({ where: { id: scope.companyId }, data: { regimenFiscal: "625" } });
    await saveDeductionReview(scope, await election({ regimenCode: "625", choice: "DEFINITIVO" }), actor);
    const data = await readDeductionReviewWorkspace(scope);
    expect(data.elecciones.find((e) => e.regimenCode === "625")?.registro?.choice).toBe("DEFINITIVO");
    expect(data.deduccionAutorizadaCentavos).toBeNull();
    expect(data.renglones[0].motivos).toContain("PLATFORM_ELECTION_REVIEW");
  });
  it("retains option revisions and rejects stale election writers", async () => {
    await prisma.company.update({ where: { id: scope.companyId }, data: { regimenFiscal: "606" } });
    await saveDeductionReview(scope, await election(), actor);
    await expect(saveDeductionReview(scope, await election(), actor)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await saveDeductionReview(scope, await election({ expectedRevision: 1, choice: "PENDIENTE", references: [] }), actor);
    expect((await readDeductionReviewHistory(scope)).elecciones.map((e) => e.revision)).toEqual([2, 1]);
    expect((await readDeductionReviewWorkspace(scope)).elecciones.find((e) => e.regimenCode === "606")?.registro?.estado).toBe("PENDIENTE");
  });
  it("ties PPD review freshness to the current REP snapshot, not the parent's issue month", async () => {
    const invoice = await prisma.invoice.update({ where: { id: invoiceId }, data: { metodoPago: "PPD", fecha: new Date("2026-08-01T12:00:00Z") } });
    const receipt = await prisma.invoice.create({ data: { companyId: scope.companyId, uuid: randomUUID(), tipo: "PAGO", tipoSat: "P", status: "STAMPED",
      fecha: new Date("2026-09-10T12:00:00Z"), formaPago: "03", metodoPago: "PUE", usoCfdi: "CP01", moneda: "MXN", subtotal: "0", total: "0",
      doctosRelacionados: { create: { parentUuid: invoice.uuid!, impPagado: "58", numParcialidad: 1, fechaPago: new Date("2026-09-10T12:00:00Z") } } } });
    await saveDeductionReview(scope, await review({ source: "PPD_REP" }), actor);
    expect((await readDeductionReviewWorkspace(scope)).renglones[0]).toMatchObject({ baseDocumentalCentavos: 5000, review: { estado: "VIGENTE" } });
    await prisma.pagoDoctoRelacionado.updateMany({ where: { pagoInvoiceId: receipt.id }, data: { impPagado: "29" } });
    expect((await readDeductionReviewWorkspace(scope)).renglones[0]).toMatchObject({ baseDocumentalCentavos: 2500, review: { estado: "DESACTUALIZADA" } });
  });
  it("rolls the review back when its central audit insert fails", async () => {
    const input = await review();
    await prisma.$executeRaw`CREATE FUNCTION "fisc002o_test_audit_failure"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END; $$`;
    await prisma.$executeRaw`CREATE TRIGGER "fisc002o_test_audit_failure" BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION "fisc002o_test_audit_failure"()`;
    try {
      await expect(saveDeductionReview(scope, input, actor)).rejects.toThrow();
      expect(await prisma.fiscalDeductionReview.count({ where: { companyId: scope.companyId } })).toBe(0);
    } finally {
      await prisma.$executeRaw`DROP TRIGGER "fisc002o_test_audit_failure" ON "AuditLog"`;
      await prisma.$executeRaw`DROP FUNCTION "fisc002o_test_audit_failure"()`;
    }
  });
  it("paginates all allocation rows without converting a preview into a full review", async () => {
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    await prisma.invoice.createMany({ data: Array.from({ length: 11 }, () => ({ companyId: scope.companyId, uuid: randomUUID(), tipo: "EGRESO" as const, tipoSat: "I", status: "STAMPED" as const,
      fecha: invoice.fecha, formaPago: "03", metodoPago: "PUE", usoCfdi: "G03", moneda: "MXN", subtotal: "100", total: "116", naturaleza: "GASTO", naturalezaManual: true })) });
    const first = await readDeductionReviewWorkspace(scope), second = await readDeductionReviewWorkspace({ ...scope, page: 2 });
    expect(first.renglones).toHaveLength(10); expect(second.renglones).toHaveLength(2);
    expect(first.resumen.asignaciones).toBe(12); expect(first.evidenceHash).toBe(second.evidenceHash);
  });
});
