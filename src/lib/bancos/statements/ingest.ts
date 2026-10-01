import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ParsedTransaction } from "@/lib/bank-parser";
import { camposContraparte, parseSpei } from "../spei-descripcion";
import { clasificarCargoBancario } from "../clasificar-cargo";
import { primeraReglaQueEmpata, signoDeMonto, type FamiliaConcepto } from "../categorizar-concepto";
import { kickCron } from "@/lib/cron-scheduler";
import { day, digest, planRows, type MovementEvidence } from "./matching";

export const MAX_STATEMENT_ROWS = 20000;
export const fileFingerprint = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export type StatementImport = {
  bankAccountId: string; companyId: string; transactions: ParsedTransaction[]; source?: string;
  banco?: string | null; periodo?: string | null; saldoInicial?: number | null; saldoFinal?: number | null;
  archivo?: { bytes: Uint8Array; nombre: string; mime: string } | null; cuadro?: boolean | null;
  holdForReview?: boolean; fileHash?: string; declaredAccount?: string | null; declaredCurrency?: string | null;
  periodStart?: string | null; periodEnd?: string | null; controls?: unknown; warnings?: string[]; userId?: string;
};
export function fromStored(row: { id: string; fecha: Date; monto: unknown; descripcion: string; referencia?: string | null; saldo?: unknown;
  claveRastreo?: string | null; bankReferenceId?: string | null; operationTime?: string | null; contraparteRfc?: string | null }): MovementEvidence {
  return { id: row.id, date: day(row.fecha), amount: Number(row.monto), description: row.descripcion, reference: row.referencia ?? null,
    balance: row.saldo == null ? null : Number(row.saldo), tracking: row.claveRastreo ?? null, bankId: row.bankReferenceId ?? null,
    time: row.operationTime ?? null, counterparty: row.contraparteRfc ?? null };
}
export function parsedEvidence(tx: ParsedTransaction, id = randomUUID()): MovementEvidence {
  const spei = parseSpei(tx.descripcion, tx.claveRastreoRaw, tx.sublineas);
  return { id, date: day(tx.fecha), amount: tx.monto, description: tx.descripcion, reference: tx.referencia ?? null,
    time: tx.hora ?? spei.hora ?? null, tracking: spei.claveRastreo ?? null, bankId: tx.bankReferenceId ?? null,
    balance: tx.saldo ?? null, counterparty: spei.contraparteRfc ?? null };
}
export async function replayStatement(companyId: string, bankAccountId: string, fileHash: string) {
  return prisma.importBatch.findFirst({ where: { companyId, bankAccountId, fileHash, undoneAt: null },
    select: { id: true, parsedCount: true, periodo: true, rows: { where: { status: "REVIEW" }, select: { id: true } } } });
}
/** All importers use the same serialized evidence intake. Financial matching
 * and posting are separate operations. An empty/newly corroborating document
 * is retained even when it creates no canonical movements. */
export async function persistStatementTransactions(opts: StatementImport) {
  if (opts.transactions.length > MAX_STATEMENT_ROWS) throw new Error("El archivo supera 20,000 movimientos. Divide por cuenta y periodo; no se importó parcialmente.");
  const source = opts.source ?? "UPLOAD";
  const rows = opts.transactions.map((row) => parsedEvidence(row));
  const hash = opts.fileHash ?? (opts.archivo ? fileFingerprint(opts.archivo.bytes) : digest({ source, rows: rows.map(({ id: _id, ...rest }) => rest),
    opening: opts.saldoInicial ?? null, closing: opts.saldoFinal ?? null, period: opts.periodo ?? null }));
  const result = await prisma.$transaction(async (db) => {
    await db.$queryRawUnsafe('SELECT id FROM "Company" WHERE id = $1 FOR UPDATE', opts.companyId);
    const account = await db.bankAccount.findFirst({ where: { id: opts.bankAccountId, companyId: opts.companyId } });
    if (!account) throw new Error("Cuenta no encontrada en esta empresa.");
    const prior = await db.importBatch.findFirst({ where: { bankAccountId: account.id, fileHash: hash }, include: { rows: { select: { status: true } } } });
    if (prior) {
      if (prior.undoneAt) throw new Error("Este archivo ya se deshizo. Revisa su historial antes de volver a importarlo.");
      return { imported: 0, skipped: prior.parsedCount, pending: prior.rows.filter((r) => r.status === "REVIEW").length, batchId: prior.id, replay: true };
    }
    const dates = rows.map((r) => new Date(r.date).getTime());
    const tracking = rows.map((r) => r.tracking).filter((s): s is string => Boolean(s));
    const bankIds = rows.map((r) => r.bankId).filter((s): s is string => Boolean(s));
    const existing = rows.length ? await db.bankTransaction.findMany({ where: { bankAccountId: account.id, companyId: opts.companyId, OR: [
      { fecha: { gte: new Date(Math.min(...dates) - 7 * 86400000), lt: new Date(Math.max(...dates) + 8 * 86400000) } },
      ...(tracking.length ? [{ claveRastreo: { in: tracking } }] : []), ...(bankIds.length ? [{ bankReferenceId: { in: bankIds } }] : []),
    ] }, take: MAX_STATEMENT_ROWS + 1, orderBy: [{ fecha: "asc" }, { id: "asc" }] }) : [];
    if (existing.length > MAX_STATEMENT_ROWS) throw new Error("Demasiados movimientos para comparar con seguridad. Divide el archivo por periodo.");
    const plans = planRows(rows, existing.map(fromStored));
    const closed = new Set((await db.accountingPeriod.findMany({ where: { companyId: opts.companyId, status: "CLOSED" }, select: { year: true, month: true } })).map((p) => `${p.year}-${String(p.month).padStart(2,"0")}`));
    const tombstones = rows.length ? await db.bankTransactionTombstone.findMany({ where: { bankAccountId: account.id,
      fecha: { gte: new Date(Math.min(...dates) - 86400000), lt: new Date(Math.max(...dates) + 86400000 * 2) } } }) : [];
    const batch = await db.importBatch.create({ data: {
      companyId: opts.companyId, bankAccountId: account.id, fileHash: hash, source, banco: opts.banco, periodo: opts.periodo,
      saldoInicial: opts.saldoInicial, saldoFinal: opts.saldoFinal, cuadro: opts.cuadro, parsedCount: rows.length,
      declaredAccount: opts.declaredAccount, declaredCurrency: opts.declaredCurrency, periodStart: opts.periodStart, periodEnd: opts.periodEnd,
      controls: opts.controls == null ? Prisma.DbNull : opts.controls as Prisma.InputJsonValue,
      warnings: opts.warnings ?? [],
      ...(opts.archivo ? { archivoPdf: new Uint8Array(opts.archivo.bytes), archivoNombre: opts.archivo.nombre, archivoMime: opts.archivo.mime } : {}),
    } });
    const rules = await db.categorizationRule.findMany({ where: { companyId: opts.companyId, activo: true, origen: "USER" } });
    let imported = 0, skipped = 0, pending = 0;
    const newMovements: Prisma.BankTransactionCreateManyInput[] = [], sourceRows: Prisma.BankStatementRowCreateManyInput[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], parsed = opts.transactions[i], plan = plans[i];
      if (closed.has(row.date.slice(0,7)) && plan.status === "NEW") {
        plan.status = "REVIEW"; plan.movementId = null; plan.reason = "El periodo está cerrado. El original se conservó sin modificar sus movimientos.";
      }
      if (opts.holdForReview && plan.status === "NEW") {
        plan.status = "REVIEW"; plan.movementId = null; plan.reason = "La extracción no pasó los controles del documento. Revisa esta fila antes de importarla.";
      }
      // Historical removals are review evidence, never an instruction to silently
      // suppress a new real payment with the same amount/day.
      if (plan.status === "NEW" && tombstones.some((t) => day(t.fecha) === row.date && Number(t.monto) === row.amount && t.descripcion === row.description && (t.referencia ?? null) === (row.reference ?? null))) {
        plan.status = "REVIEW"; plan.movementId = null; plan.reason = "Coincide con una eliminación histórica. Confirma el original antes de recuperarlo.";
      }
      if (plan.status === "NEW") {
        const spei = parseSpei(parsed.descripcion, parsed.claveRastreoRaw, parsed.sublineas);
        const matchedRule = primeraReglaQueEmpata(parsed.descripcion, signoDeMonto(parsed.monto), rules.map((r) => ({ id: r.id, pattern: r.pattern,
          matchType: r.matchType, familia: r.familia as FamiliaConcepto, signo: (r.signo as "CREDITO" | "DEBITO" | null) ?? undefined })));
        const proposed = matchedRule?.familia ?? clasificarCargoBancario(parsed.descripcion, parsed.monto);
        // A description alone does not establish a transfer between owned accounts.
        const category = proposed === "INTERNAL_TRANSFER" ? null : proposed;
        newMovements.push({ id: row.id, companyId: opts.companyId, bankAccountId: account.id,
          fecha: parsed.fecha, monto: parsed.monto, descripcion: parsed.descripcion, saldo: parsed.saldo ?? null,
          referencia: parsed.referencia ?? row.time ?? null, operationTime: row.time, bankReferenceId: row.bankId,
          tipo: parsed.monto >= 0 ? "CREDITO" : "DEBITO", status: category ? "IGNORED" : "UNMATCHED", notes: category ?? null,
          source, importBatchId: batch.id, ...camposContraparte(spei) });
        imported++;
      } else if (plan.status === "LINKED") skipped++; else pending++;
      sourceRows.push({ batchId: batch.id, rowNumber: i + 1, pageNumber: parsed.sourcePage ?? null,
        parsed: { ...row, sourceRow: parsed.sourceRow ?? i + 1, sublines: parsed.sublineas ?? [] } as Prisma.InputJsonValue,
        movementId: plan.movementId, status: plan.status, reason: plan.reason, candidateIds: plan.candidateIds });
    }
    for (let i=0;i<newMovements.length;i+=1000) await db.bankTransaction.createMany({data:newMovements.slice(i,i+1000)});
    for (let i=0;i<sourceRows.length;i+=1000) await db.bankStatementRow.createMany({data:sourceRows.slice(i,i+1000)});
    await db.importBatch.update({ where: { id: batch.id }, data: { count: imported } });
    if (opts.userId) await db.auditLog.create({ data: { companyId: opts.companyId, userId: opts.userId, accion: "bancos.statement.import",
      entidad: "ImportBatch", entidadId: batch.id, detalle: { imported, skipped, pending, source, fileHash: hash } } });
    return { imported, skipped, pending, batchId: batch.id, replay: false };
  }, { timeout: 120000 });
  const { invalidarCierre } = await import("@/lib/cierre/evaluar");
  invalidarCierre(opts.companyId);
  if (result.imported > 0) kickCron("cep-rfc", 3000, "companyId=" + opts.companyId);
  return result;
}
