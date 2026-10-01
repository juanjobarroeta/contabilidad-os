import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { rangoPeriodoMensual } from "./periodo-operativo";
import { companyRegimenCodesForPeriod, tipoPersonaFromRfc } from "./regimen-capabilities";
import { invoiceRegimenPeriodContext } from "./regimen-allocation";
import { variantesUuid } from "./uuid";
import { REP_VIGENTE } from "./rep-vigente";
import {
  decimalToSafeMicros,
  type RegimenInvoiceEvidence, type RegimenPaymentEvidence, type RegimenDocumentInput,
} from "./regimen-document-bases";

// Fetch one extra row to detect truncation. Never return partial numeric totals.
export const DOCUMENT_EVIDENCE_LIMIT = 5_000;
const take = DOCUMENT_EVIDENCE_LIMIT + 1;
const invoiceSelect = {
  id: true, uuid: true, fecha: true, tipo: true, tipoSat: true, status: true,
  metodoPago: true, moneda: true, sustituidoPorUuid: true,
  naturaleza: true, naturalezaManual: true, naturalezaRevision: true, usoCfdi: true, formaPago: true, contraparteRfc: true,
  regimenAssignment: { select: {
    revision: true,
    allocations: { select: { regimenCode: true, basisPoints: true }, orderBy: { regimenCode: "asc" } },
  } },
} satisfies Prisma.InvoiceSelect;
const paymentSelect = {
  id: true, parentUuid: true, fechaPago: true, numParcialidad: true,
  pagoInvoice: { select: { id: true, uuid: true, status: true, sustituidoPorUuid: true } },
} satisfies Prisma.PagoDoctoRelacionadoSelect;

/** Caller must authorize company membership. Read-only, repeatable snapshot. */
export async function readRegimenDocumentEvidence(companyId: string, year: number, month: number, direction: "INGRESO" | "EGRESO") {
  return prisma.$transaction((db) => readRegimenDocumentSnapshot(db, companyId, year, month, direction),
    { isolationLevel: "RepeatableRead", timeout: 15_000 });
}

/** Reuse the caller's transaction so persisted review and evidence share a snapshot. */
export async function readRegimenDocumentSnapshot(db: Prisma.TransactionClient, companyId: string, year: number, month: number, direction: "INGRESO" | "EGRESO") {
    const company = await db.company.findUnique({
      where: { id: companyId },
      select: { rfc: true, regimenFiscal: true, regimenes: { select: { code: true, since: true, endedAt: true, active: true } } },
    });
    if (!company) return null;
    const { from, to } = rangoPeriodoMensual({ year, month });
    const regimenCodes = companyRegimenCodesForPeriod({ ...company, from, to });
    const period = `${year}-${String(month).padStart(2, "0")}`;
    const empty = { period, regimenCodes, issued: [], parents: [], payments: [], history: [], linkedCreditNoteIds: [] };
    const snapshot = (input: RegimenDocumentInput) => ({ input, tipoPersona: tipoPersonaFromRfc(company.rfc), companyContext: company });
    const limitResult = () => snapshot({ ...empty, truncated: true });

    const [issued, payments] = await Promise.all([
      db.invoice.findMany({
        where: { companyId, tipo: direction, status: "STAMPED", sustituidoPorUuid: null, fecha: { gte: from, lt: to } },
        select: invoiceSelect, orderBy: { id: "asc" }, take,
      }),
      db.pagoDoctoRelacionado.findMany({
        where: {
          pagoInvoice: { companyId, ...REP_VIGENTE },
          OR: [
            { fechaPago: { gte: from, lt: to } },
            // Even a later-issued REP may document an earlier payment. Its
            // emission date cannot substitute for an unknown FechaPago.
            { fechaPago: null },
          ],
        },
        select: paymentSelect, orderBy: { id: "asc" }, take,
      }),
    ]);
    if (issued.length > DOCUMENT_EVIDENCE_LIMIT || payments.length > DOCUMENT_EVIDENCE_LIMIT) return limitResult();

    const parentUuids = variantesUuid(payments.map((p) => p.parentUuid));
    const [parents, history] = parentUuids.length ? await Promise.all([
      db.invoice.findMany({
        where: { companyId, uuid: { in: parentUuids } }, select: invoiceSelect, orderBy: { id: "asc" }, take,
      }),
      db.pagoDoctoRelacionado.findMany({
        where: { parentUuid: { in: parentUuids }, pagoInvoice: { companyId, ...REP_VIGENTE } },
        select: paymentSelect, orderBy: { id: "asc" }, take,
      }),
    ]) : [[], []];
    if (parents.length > DOCUMENT_EVIDENCE_LIMIT || history.length > DOCUMENT_EVIDENCE_LIMIT) return limitResult();

    // Also detect duplicate UUID imports outside the selected issue month. A
    // single PUE row cannot be trusted if another row has the same fiscal UUID.
    const pueUuids = variantesUuid(issued.filter((i) => i.metodoPago === "PUE").map((i) => i.uuid));
    const aliases = pueUuids.length ? await db.invoice.findMany({
      where: { companyId, uuid: { in: pueUuids } }, select: invoiceSelect, orderBy: { id: "asc" }, take,
    }) : [];
    if (aliases.length > DOCUMENT_EVIDENCE_LIMIT) return limitResult();
    const candidateUuids = variantesUuid([...issued, ...parents].filter((i) => i.tipo === direction).map((i) => i.uuid));
    const creditNotes = candidateUuids.length ? await db.invoice.findMany({
      where: { companyId, tipo: direction, tipoSat: "E", status: "STAMPED", sustituidoPorUuid: null, cfdiRelacionadoUuid: { in: candidateUuids } },
      select: { id: true }, orderBy: { id: "asc" }, take,
    }) : [];
    if (creditNotes.length > DOCUMENT_EVIDENCE_LIMIT) return limitResult();

    // The shared Prisma extension converts Decimal results to Number. SQL text
    // casts bypass that conversion without another client/connection snapshot.
    const invoiceIds = [...new Set([...issued, ...parents, ...aliases].map((row) => row.id))];
    const paymentIds = [...new Set([...payments, ...history].map((row) => row.id))];
    const [invoiceAmounts, paymentAmounts] = await Promise.all([
      invoiceIds.length ? db.$queryRaw<{ id: string; subtotal: string; descuento: string; total: string }[]>(Prisma.sql`
        SELECT id, subtotal::text AS subtotal, descuento::text AS descuento, total::text AS total
        FROM "Invoice" WHERE "companyId" = ${companyId} AND id IN (${Prisma.join(invoiceIds)})
      `) : [],
      paymentIds.length ? db.$queryRaw<{ id: string; amount: string | null }[]>(Prisma.sql`
        SELECT d.id, d."impPagado"::text AS amount FROM "PagoDoctoRelacionado" d
        JOIN "Invoice" p ON p.id = d."pagoInvoiceId"
        WHERE p."companyId" = ${companyId} AND d.id IN (${Prisma.join(paymentIds)})
      `) : [],
    ]);
    const moneyByInvoice = new Map(invoiceAmounts.map((row) => [row.id, row]));
    const moneyByPayment = new Map(paymentAmounts.map((row) => [row.id, row.amount]));

    const invoiceEvidence = (row: Prisma.InvoiceGetPayload<{ select: typeof invoiceSelect }>): RegimenInvoiceEvidence => ({
      id: row.id, uuid: row.uuid, fecha: row.fecha.toISOString(), tipo: row.tipo, tipoSat: row.tipoSat,
      status: row.status, supersededBy: row.sustituidoPorUuid, metodoPago: row.metodoPago, moneda: row.moneda,
      subtotalMicros: decimalToSafeMicros(moneyByInvoice.get(row.id)?.subtotal ?? null),
      descuentoMicros: decimalToSafeMicros(moneyByInvoice.get(row.id)?.descuento ?? null),
      totalMicros: decimalToSafeMicros(moneyByInvoice.get(row.id)?.total ?? null),
      regimenCodes: invoiceRegimenPeriodContext({ fecha: row.fecha, ...company })?.regimenCodes ?? [],
      assignment: row.regimenAssignment,
      supplierRfc: row.contraparteRfc,
      expense: { naturaleza: row.naturaleza, naturalezaManual: row.naturalezaManual, naturalezaRevision: row.naturalezaRevision,
        usoCfdi: row.usoCfdi, formaPago: row.formaPago },
    });
    const paymentEvidence = (row: Prisma.PagoDoctoRelacionadoGetPayload<{ select: typeof paymentSelect }>): RegimenPaymentEvidence => ({
      id: row.id, repInvoiceId: row.pagoInvoice.id, parentUuid: row.parentUuid, repUuid: row.pagoInvoice.uuid, status: row.pagoInvoice.status,
      supersededBy: row.pagoInvoice.sustituidoPorUuid,
      fechaPago: row.fechaPago?.toISOString() ?? null,
      amountMicros: decimalToSafeMicros(moneyByPayment.get(row.id) ?? null), installment: row.numParcialidad,
    });
    return snapshot({
      period, regimenCodes, issued: issued.map(invoiceEvidence), parents: [...parents, ...aliases].map(invoiceEvidence),
      payments: payments.map(paymentEvidence), history: history.map(paymentEvidence),
      linkedCreditNoteIds: creditNotes.map((note) => note.id), truncated: false,
    });
}
