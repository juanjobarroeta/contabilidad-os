import { createHash } from "node:crypto";
import { Prisma, type FiscalDeductionReview, type FiscalRegimeElection } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { readRegimenDocumentSnapshot, DOCUMENT_EVIDENCE_LIMIT } from "./regimen-document-evidence";
import { summarizeRegimenDeductions, DEDUCTION_REVIEW_REASONS, DEDUCTION_REVIEW_YEAR } from "./regimen-deduction-summary";
import { DEDUCTION_WORKFLOW_VERSION, ELECTION_CONTEXT_VERSION, ELECTION_CHOICES, reviewKey, type ReviewScope, type ReviewWrite } from "./deduction-review-contract";
import { readDeductionPaymentEvidence } from "./deduction-payment-evidence";
import { REP_CHECK_REASONS } from "./rep-payment-evidence";

export class DeductionReviewError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
function fail(status: number, code: string, message: string): never { throw new DeductionReviewError(status, code, message); }

// Evidence arrays are sets; DB ordering and object property order are not fiscal changes.
export function canonicalEvidence(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalEvidence).sort().join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalEvidence(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const evidenceHash = (value: unknown) => createHash("sha256").update(canonicalEvidence(value)).digest("hex");
const transactionOptions = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20_000 };
const PAGE_SIZE = 10;
const identity = (record: FiscalDeductionReview | FiscalRegimeElection) => ({
  revision: record.revision, reason: record.reason, references: record.references,
  reviewedById: record.reviewedById, reviewedByEmail: record.reviewedByEmail, reviewedAt: record.createdAt.toISOString(),
});

async function loadContext(tx: Prisma.TransactionClient, scope: ReviewScope) {
  const snapshot = await readRegimenDocumentSnapshot(tx, scope.companyId, scope.year, scope.month, "EGRESO");
  if (!snapshot) fail(404, "COMPANY_NOT_FOUND", "Empresa no encontrada.");
  const elections = await tx.$queryRaw<FiscalRegimeElection[]>(Prisma.sql`
    SELECT DISTINCT ON ("regimenCode") * FROM "FiscalRegimeElection"
    WHERE "companyId" = ${scope.companyId} AND year = ${scope.year}
    ORDER BY "regimenCode", revision DESC
  `);
  const contextHash = evidenceHash({ companyId: scope.companyId, year: scope.year,
    company: snapshot.companyContext, version: ELECTION_CONTEXT_VERSION });
  const documentary = summarizeRegimenDeductions(snapshot.input, snapshot.tipoPersona);
  const payments = await readDeductionPaymentEvidence(tx, scope.companyId, snapshot.companyContext.rfc, snapshot.input, documentary.renglones);
  const summary = { ...documentary, renglones: documentary.renglones.map((row) => ({ ...row,
    evidenciaPago: payments.byInvoice.get(row.invoiceId)!,
    elegibilidad: row.elegibilidad.map((allocation) => ({ ...allocation,
      motivos: allocation.motivos.map((reason) => reason === "PPD_PAYMENT_METHOD_UNAVAILABLE"
        && payments.byInvoice.get(row.invoiceId)?.estado === "REP_COTEJADO" ? "PAYMENT_METHOD_REVIEW" as const : reason),
    })),
  })) };
  // Conservatively invalidates ALL reviews in the month when any documentary
  // fact or election revision changes. Never trusts a previously stored amount.
  const hash = evidenceHash({ companyId: scope.companyId, snapshot, elections, payments: payments.fingerprint,
    version: DEDUCTION_WORKFLOW_VERSION, criteria: DEDUCTION_REVIEW_REASONS });
  return { snapshot, summary, elections, contextHash, hash };
}

export async function readDeductionReviewWorkspace(scope: ReviewScope) {
  return prisma.$transaction(async (tx) => {
    const context = await loadContext(tx, scope);
    const saved = await tx.$queryRaw<FiscalDeductionReview[]>(Prisma.sql`
      SELECT DISTINCT ON ("invoiceId", source, "regimenCode") * FROM "FiscalDeductionReview"
      WHERE "companyId" = ${scope.companyId} AND periodo = ${scope.periodo}
      ORDER BY "invoiceId", source, "regimenCode", revision DESC LIMIT ${DOCUMENT_EVIDENCE_LIMIT + 1}
    `);
    const overflow = saved.length > DOCUMENT_EVIDENCE_LIMIT;
    const current = new Map(saved.map((row) => [reviewKey(row), row]));
    const rows = context.summary.renglones.flatMap((row) => row.elegibilidad.map((allocation) => {
      const key = { invoiceId: row.invoiceId, source: row.source, regimenCode: allocation.regimenCode };
      const review = current.get(reviewKey(key));
      return { ...key, uuid: row.uuid, baseDocumentalCentavos: allocation.baseDocumentalCentavos,
        clasificacion: row.clasificacion, tratamiento: allocation.tratamiento, motivos: allocation.motivos, evidenciaPago: row.evidenciaPago,
        review: review ? { ...identity(review), decision: review.decision,
          estado: review.evidenceHash === context.hash ? "VIGENTE" as const : "DESACTUALIZADA" as const } : null };
    }));
    const keys = new Set(rows.map(reviewKey));
    const elections = (Object.keys(ELECTION_CHOICES) as (keyof typeof ELECTION_CHOICES)[]).map((code) => {
      const record = context.elections.find((row) => row.regimenCode === code);
      const applicable = context.snapshot.tipoPersona === "PF" && context.snapshot.input.regimenCodes.includes(code);
      return { regimenCode: code, opciones: ELECTION_CHOICES[code], aplicable: applicable,
        registro: record ? { ...identity(record), choice: record.choice, effectiveFrom: record.effectiveFrom, effectiveTo: record.effectiveTo,
          estado: record.contextHash !== context.contextHash ? "DESACTUALIZADA" as const
            : record.choice === "PENDIENTE" ? "PENDIENTE" as const
            : record.effectiveFrom > scope.periodo || record.effectiveTo < scope.periodo ? "FUERA_DE_VIGENCIA" as const : "REGISTRADA" as const } : null };
    });
    return {
      version: DEDUCTION_WORKFLOW_VERSION, periodo: scope.periodo, evidenceHash: context.hash,
      usadaEnCalculoAutomatico: false as const, deduccionAutorizadaCentavos: null,
      puedeDocumentar: !overflow && scope.year === DEDUCTION_REVIEW_YEAR && context.summary.documental.estado === "PROYECTABLE",
      limiteExcedido: overflow || context.snapshot.input.truncated,
      documental: { ...context.summary.documental, pendientes: context.summary.documental.pendientes.slice(0, 25) },
      criterios: DEDUCTION_REVIEW_REASONS, criteriosPago: REP_CHECK_REASONS, elecciones: elections,
      resumen: { asignaciones: rows.length, revisionesVigentes: rows.filter((row) => row.review?.estado === "VIGENTE" && row.review.decision !== "PENDIENTE").length,
        revisionesDesactualizadas: rows.filter((row) => row.review?.estado === "DESACTUALIZADA").length,
        revisionesSinRenglon: saved.filter((row) => !keys.has(reviewKey(row))).length,
        pendientesDocumentales: context.summary.resumen.pendientesDocumentales },
      page: scope.page, pageSize: PAGE_SIZE, pages: Math.max(1, Math.ceil(rows.length / PAGE_SIZE)),
      renglones: overflow ? [] : rows.slice((scope.page - 1) * PAGE_SIZE, scope.page * PAGE_SIZE),
    };
  }, transactionOptions);
}
export type DeductionReviewWorkspace = Awaited<ReturnType<typeof readDeductionReviewWorkspace>> & { puedeEditar: boolean };

export async function saveDeductionReview(scope: ReviewScope, body: ReviewWrite, actor: { id: string; email: string | null }) {
  const requestHash = evidenceHash({ scope: { companyId: scope.companyId, periodo: scope.periodo }, body, actorId: actor.id });
  try {
    return await prisma.$transaction(async (tx) => {
      // Unique scope+revision is the atomic compare-and-swap; no last-writer wins.
      const replay = body.kind === "review"
        ? await tx.fiscalDeductionReview.findUnique({ where: { companyId_requestId: { companyId: scope.companyId, requestId: body.requestId } } })
        : await tx.fiscalRegimeElection.findUnique({ where: { companyId_requestId: { companyId: scope.companyId, requestId: body.requestId } } });
      if (replay) {
        if (replay.requestHash !== requestHash) fail(409, "REQUEST_CONFLICT", "Este intento ya se usó con otro contenido.");
        return { revision: replay.revision, replayed: true, usadaEnCalculoAutomatico: false };
      }
      if (scope.year !== DEDUCTION_REVIEW_YEAR) fail(422, "RULE_PERIOD_REVIEW", "La captura de esta versión sólo cubre 2026.");
      const context = await loadContext(tx, scope);
      if (body.evidenceHash !== context.hash) fail(409, "EVIDENCE_CHANGED", "La evidencia cambió. Recarga y revisa antes de guardar.");
      const common = { companyId: scope.companyId, revision: body.expectedRevision + 1, reason: body.reason, references: body.references,
        requestId: body.requestId, requestHash, reviewedById: actor.id, reviewedByEmail: actor.email };
      let id: string;
      if (body.kind === "election") {
        if (context.snapshot.tipoPersona !== "PF" || !context.snapshot.input.regimenCodes.includes(body.regimenCode)) {
          fail(422, "ELECTION_NOT_APPLICABLE", "El régimen no aplica al contribuyente en este periodo.");
        }
        if (!body.effectiveFrom.startsWith(`${scope.year}-`) || !body.effectiveTo.startsWith(`${scope.year}-`)
          || scope.periodo < body.effectiveFrom || scope.periodo > body.effectiveTo) {
          fail(422, "ELECTION_PERIOD", "La vigencia informada debe pertenecer al ejercicio e incluir el mes revisado.");
        }
        const current = context.elections.find((row) => row.regimenCode === body.regimenCode);
        if ((current?.revision ?? 0) !== body.expectedRevision) fail(409, "REVISION_CONFLICT", "La opción registrada cambió. Recarga antes de guardar.");
        const result = await tx.fiscalRegimeElection.create({ data: { ...common, year: scope.year, regimenCode: body.regimenCode,
          choice: body.choice, effectiveFrom: body.effectiveFrom, effectiveTo: body.effectiveTo, contextHash: context.contextHash } });
        id = result.id;
      } else {
        const where = { companyId: scope.companyId, periodo: scope.periodo, invoiceId: body.invoiceId, source: body.source, regimenCode: body.regimenCode };
        const current = await tx.fiscalDeductionReview.findFirst({ where, orderBy: { revision: "desc" } });
        if ((current?.revision ?? 0) !== body.expectedRevision) fail(409, "REVISION_CONFLICT", "La revisión cambió. Recarga antes de guardar.");
        if (body.decision !== "PENDIENTE") {
          const [count] = await tx.$queryRaw<{ count: number }[]>(Prisma.sql`
            SELECT count(*)::integer AS count FROM (
              SELECT "invoiceId", source, "regimenCode" FROM "FiscalDeductionReview"
              WHERE "companyId" = ${scope.companyId} AND periodo = ${scope.periodo}
              GROUP BY "invoiceId", source, "regimenCode" LIMIT ${DOCUMENT_EVIDENCE_LIMIT + 1}
            ) latest
          `);
          if (count.count > DOCUMENT_EVIDENCE_LIMIT || (!current && count.count >= DOCUMENT_EVIDENCE_LIMIT)) {
            fail(422, "REVIEW_LIMIT_EXCEEDED", "Se alcanzó el límite de revisiones del periodo.");
          }
        }
        const row = context.summary.renglones.find((row) => row.invoiceId === body.invoiceId && row.source === body.source);
        const allocation = row?.elegibilidad.find((review) => review.regimenCode === body.regimenCode);
        // Reopening a vanished/invalidated row is permitted only for its own saved
        // company-scoped review. It cannot manufacture a new cross-tenant record.
        if (body.decision === "PENDIENTE" ? !current : (!allocation || context.summary.documental.estado !== "PROYECTABLE")) {
          fail(422, "DOCUMENTARY_REVIEW_REQUIRED", "Primero resuelve la evidencia documental; sólo se puede reabrir una revisión existente.");
        }
        const result = await tx.fiscalDeductionReview.create({ data: { ...common, ...where, decision: body.decision, evidenceHash: context.hash,
          snapshot: { version: DEDUCTION_WORKFLOW_VERSION, periodo: scope.periodo, tipoPersona: context.snapshot.tipoPersona,
            row: row ?? null, elecciones: context.elections.map((e) => ({ regimenCode: e.regimenCode, revision: e.revision,
              choice: e.choice, effectiveFrom: e.effectiveFrom, effectiveTo: e.effectiveTo })),
            estadoDocumental: context.summary.documental.estado } as unknown as Prisma.InputJsonValue } });
        id = result.id;
      }
      // Audit and decision commit together; a failed audit cannot lose history.
      await tx.auditLog.create({ data: { companyId: scope.companyId, userId: actor.id, actorEmail: actor.email,
        accion: body.kind === "review" ? "fiscal.documentar-revision" : "fiscal.registrar-opcion", entidad: body.kind === "review" ? "FiscalDeductionReview" : "FiscalRegimeElection", entidadId: id,
        detalle: { periodo: scope.periodo, regimenCode: body.regimenCode, revision: common.revision, referencias: body.references.length } } });
      return { revision: common.revision, replayed: false, usadaEnCalculoAutomatico: false };
    }, transactionOptions);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["P2002", "P2034"].includes(String(error.code))) {
      // A concurrent identical request may be retried with its original key.
      fail(409, "REVISION_CONFLICT", "Otro guardado cambió la revisión. Recarga o reintenta el mismo envío.");
    }
    throw error;
  }
}

export async function readDeductionReviewHistory(scope: ReviewScope) {
  const where = { companyId: scope.companyId, periodo: scope.periodo };
  const [total, rows, elections] = await prisma.$transaction(async (tx) => Promise.all([
    tx.fiscalDeductionReview.count({ where }),
    tx.fiscalDeductionReview.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20, skip: (scope.page - 1) * 20 }),
    tx.fiscalRegimeElection.findMany({ where: { companyId: scope.companyId, year: scope.year }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20, skip: (scope.page - 1) * 20 }),
  ]), transactionOptions);
  return { total, page: scope.page, pageSize: 20,
    revisiones: rows.map((row) => ({ ...identity(row), invoiceId: row.invoiceId, source: row.source, regimenCode: row.regimenCode,
      decision: row.decision, snapshot: row.snapshot })),
    elecciones: elections.map((row) => ({ ...identity(row), regimenCode: row.regimenCode, choice: row.choice, effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo })),
    usadaEnCalculoAutomatico: false };
}
