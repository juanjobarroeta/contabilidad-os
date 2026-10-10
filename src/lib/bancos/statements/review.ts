import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertPeriodoAbierto } from "@/lib/contabilidad/candado";
import { day, digest, duplicateCases, monthBounds, compatible, cents, checkControls, type MovementEvidence, type ControlTotals } from "./matching";
import { fromStored, MAX_STATEMENT_ROWS } from "./ingest";
import { parseSpei, camposContraparte } from "../spei-descripcion";

type Db = Prisma.TransactionClient;
export type ReviewScope = { companyId: string; bankAccountId: string; year: number; month: number };
export type ReviewOperation =
  | { type: "row"; rowId: string; resolution: "LINK" | "NEW" | "EXCLUDE" | "REPLACE"; movementId?: string; reason: string }
  | { type: "pair"; primaryId: string; secondaryId: string; resolution: "KEEP_BOTH" | "MERGE"; reason: string }
  | { type: "verify"; batchId: string; opening: number; closing: number; credits: number; debits: number;
      creditCount?: number | null; debitCount?: number | null; countsUnavailable: boolean;
      periodStart: string; periodEnd: string; accountConfirmed: boolean; coverageConfirmed: boolean; originalReviewed: boolean; reason: string }
  | { type: "reopen"; batchId: string; reason: string };
export type ReviewRequest = ReviewScope & { expected: string; effectExpected?: string; operation: ReviewOperation };
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const money = (n: number) => n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function accountReview(scope: ReviewScope, db: Db = prisma) {
  const { companyId, bankAccountId, year, month } = scope, bounds = monthBounds(year, month);
  const period = bounds.from.slice(0, 7);
  const scopeKey = { companyId, bankAccountId, year, month };
  const account = await db.bankAccount.findFirst({ where: { id: bankAccountId, companyId },
    select: { id: true, banco: true, nombre: true, numeroCuenta: true, clabe: true, moneda: true, tipo: true } });
  if (!account) throw new Error("Cuenta no encontrada en esta empresa.");
  const [movements, documents, decisions, accountingPeriod] = await Promise.all([
    db.bankTransaction.findMany({ where: { companyId, bankAccountId, fecha: { gte: bounds.start, lt: bounds.end } },
      orderBy: [{ fecha: "asc" }, { id: "asc" }], take: MAX_STATEMENT_ROWS + 1 }),
    db.importBatch.findMany({ where: { companyId, bankAccountId, undoneAt: null, OR: [
      { periodo: { startsWith: period } }, { verifiedYear: year, verifiedMonth: month },
      { periodStart: { lte: bounds.to }, periodEnd: { gte: bounds.from } },
      { transactions: { some: { fecha: { gte: bounds.start, lt: bounds.end } } } },
      { rows: { some: { parsed: { path: ["date"], string_starts_with: period } } } },
    ] }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 101, select: {
      id: true, createdAt: true, source: true, banco: true, periodo: true, kind: true, fileHash: true,
      archivoNombre: true, archivoMime: true, parsedCount: true, count: true, cuadro: true,
      saldoInicial: true, saldoFinal: true, controls: true, reviewAttestation: true, warnings: true, declaredAccount: true, declaredCurrency: true,
      periodStart: true, periodEnd: true, verifiedAt: true, verifiedByUserId: true, verificationHash: true, verifiedYear: true, verifiedMonth: true,
      rows: { orderBy: { rowNumber: "asc" }, take: MAX_STATEMENT_ROWS + 1 },
    } }),
    db.bankReviewDecision.findMany({ where: { companyId, bankAccountId, action: { in: ["KEEP_BOTH", "MERGE"] } }, select: { pairKey: true, fingerprint: true } }),
    db.accountingPeriod.findUnique({ where: { companyId_year_month: { companyId, year, month } }, select: { status: true } }),
  ]);
  if (movements.length > MAX_STATEMENT_ROWS || documents.length > 100 || documents.some((d) => d.rows.length > MAX_STATEMENT_ROWS)) {
    throw new Error("La revisión excede el límite seguro de 20,000 movimientos o 100 documentos del mes. No se verificó una muestra parcial.");
  }
  const candidateIds = [...new Set(documents.flatMap((d) => d.rows.flatMap((r) => r.candidateIds)))].filter((id) => !movements.some((m) => m.id === id));
  if (candidateIds.length > MAX_STATEMENT_ROWS) throw new Error("Demasiados candidatos para una revisión completa.");
  const adjacent = candidateIds.length ? await db.bankTransaction.findMany({ where: { companyId, bankAccountId, id: { in: candidateIds } } }) : [];
  const candidates = [...movements, ...adjacent];
  const evidence = movements.map(fromStored);
  const duplicates = duplicateCases(evidence, decisions);
  const unresolved = documents.flatMap((d) => d.rows.filter((r) => r.status === "REVIEW").map((r) => ({ ...r, documentId: d.id, filename: d.archivoNombre })));
  const hash = digest({ scope: scopeKey, account, movements: evidence, adjacent: adjacent.map(fromStored).sort((a,b) => a.id.localeCompare(b.id)), decisions: decisions.slice().sort((a, b) => (a.pairKey + a.fingerprint).localeCompare(b.pairKey + b.fingerprint)),
    documents: documents.map((d) => ({ id: d.id, fileHash: d.fileHash, kind: d.kind, opening: d.saldoInicial, closing: d.saldoFinal,
      controls: d.controls, attestation: d.reviewAttestation, start: d.periodStart, end: d.periodEnd, rows: d.rows.map((r) => ({ id: r.id, parsed: r.parsed, status: r.status, movementId: r.movementId })) })).sort((a, b) => a.id.localeCompare(b.id)) });
  const verified = documents.find((d) => d.verifiedYear === year && d.verifiedMonth === month && d.verifiedAt && d.verificationHash === hash);
  return { scope: scopeKey, account, period, hash, movements, candidates, evidence, documents, duplicates, unresolved, verified: verified?.id ?? null,
    status: verified ? "VERIFIED" : documents.some((d) => d.verifiedAt) ? "CHANGED" : "PROVISIONAL", closed: accountingPeriod?.status === "CLOSED" };
}
export type AccountReview = Awaited<ReturnType<typeof accountReview>>;

/** Bounded, paginated evidence for both the bank page and the model. */
export function reviewPage(review: AccountReview, cursor = 0, limit = 50) {
  const start = Math.max(0, Math.floor(cursor)), size = Math.min(100, Math.max(1, Math.floor(limit)));
  const items = [
    ...review.unresolved.map((r) => ({ type: "row" as const, id: r.id, documentId: r.documentId, filename: r.filename, row: r.rowNumber,
      page: r.pageNumber, evidence: r.parsed, reason: r.reason, candidates: review.candidates.filter((m) => r.candidateIds.includes(m.id)).map((m) => ({ ...fromStored(m), status: m.status, source: m.source, importBatchId: m.importBatchId })) })),
    ...review.duplicates.map((d) => ({ type: "pair" as const, ...d, movements: review.movements.filter((m) => d.ids.includes(m.id)).map((m) => ({ ...fromStored(m), status: m.status, source: m.source, importBatchId: m.importBatchId })) })),
  ];
  return { scope: review.scope, account: { ...review.account, numeroCuenta: "••••" + review.account.numeroCuenta.slice(-4), clabe: undefined },
    period: review.period, hash: review.hash, status: review.status, closed: review.closed, verifiedDocumentId: review.verified,
    movementCount: review.movements.length, unresolvedCount: review.unresolved.length, duplicateCaseCount: review.duplicates.length,
    documents: review.documents.map(({ rows, ...d }) => ({ ...d, sourceRows: rows.length, linked: rows.filter((r) => r.movementId && r.status !== "EXCLUDED").length,
      unresolved: rows.filter((r) => r.status === "REVIEW").length, originalUrl: d.archivoNombre ? "/api/bancos/import-batches/" + d.id + "/pdf" : null })),
    items: items.slice(start, start + size), totalItems: items.length, nextCursor: start + size < items.length ? start + size : null,
    coverage: "La revisión se calculó con todos los movimientos del mes; sólo la presentación está paginada." };
}
export function documentPage(review: AccountReview, documentId: string, cursor = 0) {
  const document = review.documents.find((d) => d.id === documentId);
  if (!document) throw new Error("Documento no encontrado en esta cuenta y mes.");
  const linked = new Set(document.rows.filter((r) => r.status !== "EXCLUDED").map((r) => r.movementId));
  const missing = review.evidence.filter((m) => !linked.has(m.id));
  const items = [...document.rows.map((r) => ({ type: "source_row" as const, ...r })), ...missing.map((m) => ({ type: "uncovered_movement" as const, ...m }))];
  const start = Math.max(0, Math.floor(cursor));
  return { scope: review.scope, hash: review.hash, documentId, sourceRows: document.rows.length, uncoveredCount: missing.length,
    items: items.slice(start, start + 50), totalItems: items.length, nextCursor: start + 50 < items.length ? start + 50 : null };
}
async function removalEvidence(db: Db, scope: ReviewScope, movementId: string) {
  await db.$queryRaw`SELECT id FROM "BankTransaction" WHERE id = ${movementId} AND "companyId" = ${scope.companyId} FOR UPDATE`;
  const movement = await db.bankTransaction.findFirst({ where: { id: movementId, companyId: scope.companyId, bankAccountId: scope.bankAccountId },
    include: { cepMovimiento: true, conciliacionDetalles: { select: { id: true } }, devolucionPor: { select: { id: true } },
      gastoPagado: { select: { id: true } }, reembolsoPagado: { select: { id: true } }, rayaPagada: { select: { id: true } }, solicitudCompraPagada: { select: { id: true } },
      adjudicacionPagada: { select: { id: true } }, hospLiquidacion: { select: { id: true } }, estimacionCobrada: { select: { id: true } },
      reservacionCobrada: { select: { id: true } }, compraRestPagada: { select: { id: true } }, ordenRestCobrada: { select: { id: true } },
      purifVentaCobrada: { select: { id: true } }, purifGastoPagado: { select: { id: true } }, purifCompraPagada: { select: { id: true } },
      salCompraPagada: { select: { id: true } }, salPagoRecibido: { select: { id: true } }, statementRows: true,
    } });
  if (!movement) throw new Error("Movimiento no encontrado en esta cuenta.");
  if (movement.invoiceId || movement.taxDeclarationId || movement.conciliacionDetalles.length || movement.devolucionDeId || movement.devolucionPor ||
    movement.gastoPagado || movement.reembolsoPagado || movement.rayaPagada || movement.solicitudCompraPagada || movement.adjudicacionPagada || movement.hospLiquidacion ||
    movement.estimacionCobrada || movement.reservacionCobrada || movement.compraRestPagada || movement.ordenRestCobrada || movement.purifVentaCobrada ||
    movement.purifGastoPagado || movement.purifCompraPagada || movement.salCompraPagada || movement.salPagoRecibido || movement.comisionDeId || movement.externalRef) {
    throw new Error("El movimiento tiene aplicaciones operativas o fiscales. Desvincúlalas en la mesa antes de corregirlo; se conserva la evidencia.");
  }
  if (await db.bankTransaction.count({ where: { companyId: scope.companyId, comisionDeId: movement.id } })) throw new Error("Desvincula las comisiones asociadas antes de corregir esta operación.");
  const entries = await db.accountingEntry.findMany({ where: { companyId: scope.companyId, referencia: movementId }, orderBy: { id: "asc" }, take: 101,
    include: { chartAccount: { select: { cuentaSAT: true, subcuenta: true, nombre: true } } } });
  if (entries.length > 100) throw new Error("La operación tiene más de 100 asientos. Requiere revisión contable individual; no se preparó una reversión parcial.");
  if (entries.some((e) => e.fuente !== "BANCO" || e.referenciaTipo !== "BANK_TX")) throw new Error("Hay asientos fuera de la póliza bancaria. Requieren revisión contable individual.");
  if (entries.reduce((n, e) => n + (e.tipo === "CARGO" ? cents(Number(e.monto)) : -cents(Number(e.monto))), 0) !== 0) throw new Error("La póliza de origen no cuadra. No se generó una reversión parcial.");
  await assertPeriodoAbierto(db, scope.companyId, movement.fecha.getUTCFullYear(), movement.fecha.getUTCMonth() + 1);
  for (const e of entries) await assertPeriodoAbierto(db, scope.companyId, e.year, e.month);
  return { movement, entries };
}
function requireReason(reason: string) { if (typeof reason !== "string" || reason.trim().length < 8 || reason.length > 1000) throw new Error("Explica la decisión (8 a 1,000 caracteres)."); }

export function verificationErrors(review: AccountReview, op: Extract<ReviewOperation, { type: "verify" }>) {
  const errors: string[] = [], doc = review.documents.find((d) => d.id === op.batchId), bounds = monthBounds(review.scope.year, review.scope.month);
  if (!doc) return ["Documento no encontrado en esta cuenta y periodo."];
  if (!op.accountConfirmed || !op.coverageConfirmed || !op.originalReviewed) errors.push("Confirma cuenta, moneda, cobertura completa y revisión del original.");
  if (bounds.end.getTime() > Date.now()) errors.push("El mes aún no termina; el estado permanece provisional.");
  if (op.periodStart !== bounds.from || op.periodEnd !== bounds.to) errors.push("La cobertura confirmada debe ser el mes completo.");
  if ((doc.periodStart && doc.periodStart > bounds.from) || (doc.periodEnd && doc.periodEnd < bounds.to)) errors.push("El documento declara una cobertura parcial; falta el resto del mes.");
  const declaredDigits = (doc.declaredAccount ?? "").replace(/\D/g, "");
  if (declaredDigits.length >= 4 && ![review.account.numeroCuenta, review.account.clabe ?? ""].some((v) => v.replace(/\D/g, "").endsWith(declaredDigits.slice(-4)))) errors.push("La cuenta impresa no coincide con la cuenta seleccionada.");
  if (doc.declaredCurrency && doc.declaredCurrency.toUpperCase() !== review.account.moneda.toUpperCase()) errors.push("La moneda del documento difiere de la cuenta.");
  if (review.unresolved.length) errors.push(String(review.unresolved.length) + " filas de documentos siguen sin resolver.");
  if (review.duplicates.length) errors.push(String(review.duplicates.length) + " posibles duplicados necesitan una decisión.");
  const rows = doc.rows.filter((r) => r.status !== "EXCLUDED");
  const ids = rows.map((r) => r.movementId);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) errors.push("Cada fila del estado debe corresponder a una operación distinta.");
  const missing = review.movements.filter((m) => !ids.includes(m.id));
  if (missing.length) errors.push(String(missing.length) + " movimientos del sistema no están cubiertos por este estado.");
  for (const row of rows) {
    const observation = row.parsed as unknown as MovementEvidence;
    const movement = review.evidence.find((m) => m.id === row.movementId);
    if (!movement || !compatible(observation, movement)) { errors.push("Una fila no coincide en fecha, importe o identidad con su movimiento."); break; }
  }
  if (rows.some((r) => { const date = (r.parsed as unknown as MovementEvidence).date; return date < bounds.from || date > bounds.to; })) errors.push("El documento incluye movimientos fuera del mes seleccionado.");
  if (!op.countsUnavailable && (op.creditCount == null || op.debitCount == null)) errors.push("Captura los conteos del banco o confirma que el original no los imprime.");
  const controls: ControlTotals = { credits: op.credits, debits: op.debits, creditCount: op.creditCount, debitCount: op.debitCount };
  errors.push(...checkControls(rows.map((r) => r.parsed as unknown as MovementEvidence), op.opening, op.closing, controls).errors);
  return errors;
}
export async function previewReview(request: ReviewRequest, db: Db = prisma) {
  requireReason(request.operation.reason);
  const review = await accountReview(request, db);
  if (request.expected !== review.hash) throw new Error("La evidencia cambió. Actualiza la revisión antes de confirmar.");
  const op = request.operation;
  if (review.closed) throw new Error("El periodo está cerrado. Reábrelo formalmente antes de modificar su evidencia bancaria.");
  let summary: string, removal: Awaited<ReturnType<typeof removalEvidence>> | null = null;
  if (op.type === "verify") {
    const errors = verificationErrors(review, op); if (errors.length) throw new Error(errors.join(" "));
    const original = await db.importBatch.findFirst({ where: { id: op.batchId, companyId: request.companyId }, select: { archivoPdf: true } });
    if (!original?.archivoPdf?.length) throw new Error("Falta el archivo original. Súbelo para poder verificar el estado.");
    summary = "Verificar el estado completo de " + review.account.nombre + " · " + review.period + ": " + review.movements.length + " movimientos; saldo inicial $" + money(op.opening) + ", abonos $" + money(op.credits) + ", cargos $" + money(op.debits) + ", saldo final $" + money(op.closing) + ". Habilita su contabilización mientras la evidencia siga vigente.";
  } else if (op.type === "reopen") {
    if (!review.documents.some((d) => d.id === op.batchId)) throw new Error("Documento no encontrado.");
    summary = "Reabrir la verificación bancaria de " + review.period + ". Se conservan documentos y asientos.";
  } else if (op.type === "pair") {
    const primary = review.movements.find((m) => m.id === op.primaryId), secondary = review.movements.find((m) => m.id === op.secondaryId);
    if (!primary || !secondary || primary.id === secondary.id) throw new Error("Selecciona dos movimientos distintos de esta cuenta y mes.");
    if (op.resolution === "MERGE") {
      if (!compatible(fromStored(primary), fromStored(secondary))) throw new Error("La fecha, el importe o los identificadores distinguen estas operaciones. No se fusionaron.");
      removal = await removalEvidence(db, request, secondary.id);
    }
    summary = op.resolution === "KEEP_BOTH" ? "Conservar ambas operaciones de $" + money(Math.abs(Number(primary.monto))) + " como pagos distintos y recordar la decisión." :
      "Conservar " + primary.id + " y retirar la copia " + secondary.id + " por $" + money(Math.abs(Number(secondary.monto))) + ". Sus documentos quedarán vinculados a la operación conservada.";
  } else {
    const row = review.documents.flatMap((d) => d.rows).find((r) => r.id === op.rowId);
    if (!row) throw new Error("Fila no encontrada en este periodo.");
    if (op.resolution === "LINK" || op.resolution === "REPLACE") {
      const target = review.candidates.find((m) => m.id === op.movementId);
      if (!target) throw new Error("Selecciona un movimiento de esta cuenta y periodo.");
      if (op.resolution === "LINK") {
        if (!compatible(row.parsed as unknown as MovementEvidence, fromStored(target))) throw new Error("La evidencia difiere: requiere corregir el movimiento, no enlazarlo silenciosamente.");
        if (row.movementId && row.movementId !== target.id) throw new Error("Esta fila ya creó otro movimiento. Usa la revisión de duplicados para conservar su efecto contable.");
        if (review.documents.find((d) => d.id === row.batchId)!.rows.some((r) => r.id !== row.id && r.movementId === target.id && r.status !== "EXCLUDED")) throw new Error("Otra fila de este documento ya usa ese movimiento. Confirma si hay una lectura repetida u otra operación.");
      } else {
        if (row.movementId) throw new Error("La fila ya tiene movimiento. Resuelve la copia antes de reemplazar otra operación.");
        removal = await removalEvidence(db, request, target.id);
      }
    }
    if (op.resolution === "NEW" && row.movementId) throw new Error("La fila ya tiene movimiento; no se creará otra copia.");
    if (op.resolution === "EXCLUDE" && row.movementId) {
      const other = await db.bankStatementRow.count({ where: { movementId: row.movementId, id: { not: row.id }, status: { not: "EXCLUDED" } } });
      if (!other) removal = await removalEvidence(db, request, row.movementId);
    }
    const observation = row.parsed as unknown as MovementEvidence;
    summary = ({ LINK: "Vincular a la operación existente", NEW: "Conservar como una operación adicional", EXCLUDE: "Excluir esta fila de la extracción", REPLACE: "Corregir la operación usando esta versión del estado" })[op.resolution] +
      ": " + observation.date + " · " + observation.description + " · $" + money(observation.amount) + ".";
  }
  if (removal?.entries.length) summary += " Se conservarán los originales y se crearán estas contrapartidas exactas: " + removal.entries.map((e) =>
    `${e.tipo === "CARGO" ? "Abono" : "Cargo"} $${money(Number(e.monto))} a ${e.chartAccount.subcuenta ?? e.chartAccount.cuentaSAT} ${e.chartAccount.nombre} (${e.year}-${String(e.month).padStart(2,"0")})`).join("; ") + ". Originales y reversiones se conservarán al regenerar el mes.";
  const effectHash = digest({ expected: review.hash, operation: op, removal, summary });
  if (request.effectExpected && request.effectExpected !== effectHash) throw new Error("Cambió el efecto contable de la propuesta. Revisa una vista previa nueva.");
  return { review, summary, removal, expected: review.hash, effectHash, ledgerEffect: removal?.entries.map((e) => ({ id: e.id, accountId: e.chartAccountId, accountCode: e.chartAccount.subcuenta ?? e.chartAccount.cuentaSAT, accountName: e.chartAccount.nombre, original: e.tipo, reversal: e.tipo === "CARGO" ? "ABONO" : "CARGO", amount: Number(e.monto), year: e.year, month: e.month })) ?? [] };
}


async function refreshTotals(db: Db, companyId: string, year: number, month: number) {
  const sums = await db.accountingEntry.groupBy({ by: ["tipo"], where: { companyId, year, month }, _sum: { monto: true }, _count: { _all: true } });
  await db.accountingPeriod.updateMany({ where: { companyId, year, month }, data: {
    entriesCount: sums.reduce((n, r) => n + r._count._all, 0), totalCargos: sums.find((r) => r.tipo === "CARGO")?._sum.monto ?? 0,
    totalAbonos: sums.find((r) => r.tipo === "ABONO")?._sum.monto ?? 0,
  } });
}
async function removeReviewedMovement(db: Db, scope: ReviewScope, info: Awaited<ReturnType<typeof removalEvidence>>, decisionId: string, userId: string, replacementId?: string) {
  const m = info.movement;
  // Preserve originals and explicit balanced reversals outside regenerated sources.
  // Their net is zero and remains zero after monthly regeneration.
  for (const e of info.entries) {
    await db.accountingEntry.update({ where: { id: e.id }, data: { fuente: "MANUAL", referenciaTipo: "BANK_REVIEW_ORIGINAL" } });
    await db.accountingEntry.create({ data: { companyId: e.companyId, chartAccountId: e.chartAccountId, fecha: e.fecha, year: e.year, month: e.month,
      periodId: e.periodId, descripcion: "Reversión revisada: " + e.descripcion.slice(0, 170), referencia: decisionId, referenciaTipo: "BANK_REVIEW_REVERSAL",
      monto: e.monto, tipo: e.tipo === "CARGO" ? "ABONO" : "CARGO", fuente: "MANUAL" } });
  }
  for (const row of m.statementRows) {
    const collision = replacementId && await db.bankStatementRow.findFirst({ where: { batchId: row.batchId, movementId: replacementId, status: { not: "EXCLUDED" }, id: { not: row.id } } });
    await db.bankStatementRow.update({ where: { id: row.id }, data: { movementId: replacementId ?? null, status: replacementId && !collision ? "LINKED" : "EXCLUDED",
      reason: "Decisión confirmada " + decisionId + "; se conserva la observación original.", decidedAt: new Date(), decidedByUserId: userId } });
  }
  await db.bankTransactionTombstone.create({ data: { companyId: scope.companyId, bankAccountId: scope.bankAccountId, txId: m.id,
    fecha: m.fecha, monto: m.monto, descripcion: m.descripcion, referencia: m.referencia, motivo: "review:" + decisionId, userId } });
  await db.bankTransaction.delete({ where: { id: m.id } });
  for (const key of new Set(info.entries.map((e) => e.year + ":" + e.month))) {
    const [year, month] = key.split(":").map(Number); await refreshTotals(db, scope.companyId, year, month);
  }
}
async function createFromRow(db: Db, scope: ReviewScope, row: { id: string; batchId: string; parsed: Prisma.JsonValue }) {
  const p = row.parsed as unknown as MovementEvidence & { sublines?: string[] };
  if (!Number.isFinite(p.amount) || !p.amount || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new Error("La extracción necesita corregirse antes de crear la operación.");
  const date = new Date(p.date + "T12:00:00Z");
  await assertPeriodoAbierto(db, scope.companyId, date.getUTCFullYear(), date.getUTCMonth() + 1);
  return db.bankTransaction.create({ data: { id: randomUUID(), companyId: scope.companyId, bankAccountId: scope.bankAccountId,
    fecha: date, monto: p.amount, descripcion: p.description, referencia: p.reference ?? p.time ?? null, saldo: p.balance,
    operationTime: p.time, bankReferenceId: p.bankId, tipo: p.amount > 0 ? "CREDITO" : "DEBITO", status: "UNMATCHED",
    source: "STATEMENT_REVIEW", importBatchId: row.batchId,
    ...camposContraparte(parseSpei(p.description, p.tracking ?? undefined, p.sublines)),
  } });
}
export async function executeReview(request: ReviewRequest, userId: string) {
  if (!request.effectExpected) throw new Error("Prepara la vista previa antes de confirmar.");
  const result = await prisma.$transaction(async (db) => {
    await db.$queryRawUnsafe('SELECT id FROM "Company" WHERE id = $1 FOR UPDATE', request.companyId);
    await db.$queryRawUnsafe('SELECT id FROM "AccountingPeriod" WHERE "companyId" = $1 AND year = $2 AND month = $3 FOR UPDATE', request.companyId, request.year, request.month);
    const prepared = await previewReview(request, db), { review, removal } = prepared, op = request.operation;
    const decisionId = randomUUID();
    if (op.type === "verify") {
      await db.importBatch.update({ where: { id: op.batchId }, data: { kind: "STATEMENT", reviewAttestation: json({ ...op, userId, confirmedAt: new Date() }) } });
      const updated = await accountReview(request, db);
      await db.importBatch.update({ where: { id: op.batchId }, data: { verifiedAt: new Date(), verifiedByUserId: userId,
        verifiedYear: request.year, verifiedMonth: request.month, verificationHash: updated.hash } });
      await db.conciliacionBancaria.upsert({ where: { bankAccountId_year_month: { bankAccountId: request.bankAccountId, year: request.year, month: request.month } },
        create: { companyId: request.companyId, bankAccountId: request.bankAccountId, year: request.year, month: request.month,
          saldoInicialEstado: op.opening, saldoFinalEstado: op.closing, saldoManual: true },
        update: { saldoInicialEstado: op.opening, saldoFinalEstado: op.closing, saldoManual: true, conciliadoAt: null, conciliadoByUserId: null } });
    } else if (op.type === "reopen") {
      await db.importBatch.update({ where: { id: op.batchId }, data: { verifiedAt: null, verifiedByUserId: null, verificationHash: null } });
    } else if (op.type === "pair") {
      const pair = review.evidence.filter((m) => m.id === op.primaryId || m.id === op.secondaryId).sort((a, b) => a.id.localeCompare(b.id));
      await db.bankReviewDecision.create({ data: { id: decisionId, companyId: request.companyId, bankAccountId: request.bankAccountId,
        pairKey: pair.map((m) => m.id).join(":"), fingerprint: digest(pair), action: op.resolution, reason: op.reason, userId,
        snapshot: json({ pair, removal, ledgerEffect: prepared.ledgerEffect }) } });
      if (removal) await removeReviewedMovement(db, request, removal, decisionId, userId, op.primaryId);
    } else {
      const row = review.documents.flatMap((d) => d.rows).find((r) => r.id === op.rowId)!;
      let movementId: string | null = op.resolution === "LINK" ? op.movementId! : row.movementId;
      if (op.resolution === "NEW" || op.resolution === "REPLACE") {
        const created = await createFromRow(db, request, row); movementId = created.id;
        if (op.resolution === "NEW") for (const id of row.candidateIds) {
          const other = review.candidates.find((m) => m.id === id); if (!other) continue;
          const pair = [fromStored(created), fromStored(other)].sort((a, b) => a.id.localeCompare(b.id));
          await db.bankReviewDecision.upsert({ where: { companyId_pairKey_fingerprint: { companyId: request.companyId, pairKey: pair.map((m) => m.id).join(":"), fingerprint: digest(pair) } },
            create: { companyId: request.companyId, bankAccountId: request.bankAccountId, pairKey: pair.map((m) => m.id).join(":"), fingerprint: digest(pair),
              action: "KEEP_BOTH", reason: op.reason, userId, snapshot: json(pair) }, update: {} });
        }
      }
      if (removal) {
        await db.bankReviewDecision.create({ data: { id: decisionId, companyId: request.companyId, bankAccountId: request.bankAccountId,
          pairKey: "row:" + row.id, fingerprint: digest({ row, removal }), action: op.resolution, reason: op.reason, userId, snapshot: json({ row, removal, replacementId: movementId }) } });
        await removeReviewedMovement(db, request, removal, decisionId, userId, op.resolution === "REPLACE" ? movementId! : undefined);
      }
      await db.bankStatementRow.update({ where: { id: row.id }, data: { movementId: op.resolution === "EXCLUDE" ? null : movementId,
        status: op.resolution === "EXCLUDE" ? "EXCLUDED" : "LINKED", reason: op.reason, decidedAt: new Date(), decidedByUserId: userId } });
    }
    await db.auditLog.create({ data: { companyId: request.companyId, userId, accion: "bancos.statement." + op.type, entidad: "BankStatementReview", entidadId: decisionId,
      detalle: json({ scope: review.scope, operation: op, beforeHash: review.hash, summary: prepared.summary, ledgerEffect: prepared.ledgerEffect }) } });
    return { ok: true as const, message: op.type === "verify" ? "Estado verificado. Su vigencia se revisará antes de contabilizar." : "Decisión registrada; documentos y rastro contable conservados.", decisionId };
  }, { timeout: 120000 });
  const { invalidarCierre } = await import("@/lib/cierre/evaluar");
  invalidarCierre(request.companyId);
  return result;
}

export async function statementPostingGate(companyId: string, year: number, month: number, db: Db = prisma, onlyAccountId?: string) {
  monthBounds(year, month);
  // Known real bank accounts need monthly coverage, including zero-activity
  // months. Satellite bridge accounts retain their existing separate workflow.
  const accounts = await db.bankAccount.findMany({ where: { companyId, ...(onlyAccountId ? { id: onlyAccountId } : {}), tipo: { not: "CAJA" }, OR: [
    { transactions: { none: {} } },
    { transactions: { some: { source: { in: ["UPLOAD", "UPLOAD_PDF", "WHATSAPP", "BELVO", "STATEMENT_REVIEW", "MANUAL"] } } } },
    { importBatches: { some: { undoneAt: null } } },
  ] }, select: { id: true, nombre: true } });
  const states = [];
  for (const account of accounts) {
    const review = await accountReview({ companyId, bankAccountId: account.id, year, month }, db);
    states.push({ bankAccountId: account.id, name: account.nombre, status: review.status, hash: review.hash, verified: review.verified,
      postingFingerprint: digest(review.movements.map((m) => ({ id: m.id, status: m.status, notes: m.notes, invoiceId: m.invoiceId, taxDeclarationId: m.taxDeclarationId, loanAccountId: m.loanAccountId }))),
      pending: review.unresolved.length, duplicates: review.duplicates.length });
  }
  return { ok: states.every((s) => Boolean(s.verified)), hash: digest(states), accounts: states,
    message: states.filter((s) => !s.verified).map((s) => s.name + ": falta verificar el estado completo" + (s.pending ? " (" + s.pending + " filas por revisar)" : "")).join("; ") };
}
