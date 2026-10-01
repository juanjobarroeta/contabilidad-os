import type { InvoiceRegimenAllocationInput } from "./regimen-allocation";
import { VALID_REGIMENES } from "./regimen-capabilities";
import {
  projectRegimenBase, proratePpdBaseCentavos, validatePpdPaymentHistory,
  type RegimenPaymentProjectionCode,
} from "./regimen-payment-allocation";
import { normalizarUuid } from "./uuid";

export interface RegimenInvoiceEvidence {
  id: string;
  uuid: string | null;
  fecha: string;
  tipo: string;
  tipoSat: string | null;
  status: string;
  supersededBy: string | null;
  metodoPago: string;
  moneda: string;
  subtotalMicros: number | null;
  descuentoMicros: number | null;
  totalMicros: number | null;
  regimenCodes: string[];
  assignment: { revision: number; allocations: InvoiceRegimenAllocationInput[] } | null;
  supplierRfc?: string | null;
  expense?: {
    naturaleza: string | null;
    naturalezaRevision: boolean;
    naturalezaManual: boolean;
    usoCfdi: string;
    formaPago: string;
  };
}

export interface RegimenPaymentEvidence {
  id: string;
  repInvoiceId?: string;
  parentUuid: string;
  repUuid: string | null;
  status: string;
  supersededBy: string | null;
  fechaPago: string | null;
  amountMicros: number | null;
  installment: number | null;
}

export type RegimenDocumentIssueCode = RegimenPaymentProjectionCode
  | "EVIDENCE_LIMIT_EXCEEDED" | "INVALID_PERIOD" | "INVALID_INVOICE_AMOUNTS"
  | "INVALID_INVOICE_DATE" | "MISSING_INVOICE_UUID" | "AMBIGUOUS_INVOICE_UUID"
  | "UNSUPPORTED_DOCUMENT" | "UNSUPPORTED_PAYMENT_METHOD" | "FOREIGN_CURRENCY_REVIEW"
  | "CREDIT_NOTE_REVIEW" | "MISSING_REP_UUID" | "PAYMENT_DATE_UNAVAILABLE"
  | "DUPLICATE_PAYMENT_CONFLICT" | "DUPLICATE_INSTALLMENT" | "PAYMENT_SNAPSHOT_MISMATCH"
  | "PAYMENT_INSTALLMENT_UNAVAILABLE" | "PAYMENT_HISTORY_GAP"
  | "PARENT_NOT_FOUND" | "PARENT_NOT_ELIGIBLE" | "PAYMENT_BEFORE_INVOICE"
  | "PAYMENT_HISTORY_AMOUNT_UNAVAILABLE" | "CUMULATIVE_PAYMENT_EXCEEDS_PARENT_TOTAL"
  | "CUMULATIVE_ROUNDING_REVIEW" | "UNSAFE_AGGREGATE";

export interface RegimenDocumentInput {
  period: string;
  regimenCodes: string[];
  /** All stamped documents in the selected direction issued in the month, including credit notes. */
  issued: RegimenInvoiceEvidence[];
  /** All company-local invoices matching current REP parent UUIDs. */
  parents: RegimenInvoiceEvidence[];
  payments: RegimenPaymentEvidence[];
  history: RegimenPaymentEvidence[];
  /** Stamped same-direction credit notes linked to a candidate, regardless of issue month. */
  linkedCreditNoteIds: string[];
  truncated: boolean;
}

export interface RegimenDocumentIssue {
  id: string;
  code: RegimenDocumentIssueCode;
}

export interface RegimenDocumentRow {
  invoiceId: string;
  uuid: string;
  source: "PUE_DOCUMENTADO" | "PPD_REP";
  assignmentRevision: number | null;
  baseCentavos: number;
  allocations: { regimenCode: string; amountCentavos: number }[];
  evidenceIds: string[];
}

export interface RegimenDocumentSummary {
  version: 1;
  periodo: string;
  estado: "SIN_EVIDENCIA" | "PROYECTABLE" | "PENDIENTE";
  usadaEnCalculoAutomatico: false;
  totales: null | { pueDocumentadoCentavos: number; ppdRepCentavos: number };
  porRegimen: null | { regimenCode: string; pueDocumentadoCentavos: number; ppdRepCentavos: number }[];
  renglones: RegimenDocumentRow[];
  pendientes: RegimenDocumentIssue[];
  duplicadosOmitidos: number;
}

/** Parse database Decimal strings without a Number/float round trip. */
export function decimalToSafeMicros(value: string | null): number | null {
  if (value === null || !/^\d+(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const micros = BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, "0"));
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
}

const validMicros = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value >= 0;
const roundMicros = (value: number) => Number((BigInt(value) + BigInt(5_000)) / BigInt(10_000));
const timestamp = (value: string | null) => value === null ? NaN : Date.parse(value);
const paymentKey = (p: RegimenPaymentEvidence) => `${normalizarUuid(p.repUuid ?? "")}::${normalizarUuid(p.parentUuid)}`;
const paymentSignature = (p: RegimenPaymentEvidence) => JSON.stringify([p.amountMicros, p.fechaPago, p.installment]);

/** Documentary income or expense bases only. This function cannot authorize tax calculation. */
export function summarizeRegimenDocumentBases(input: RegimenDocumentInput, direction: "INGRESO" | "EGRESO"): RegimenDocumentSummary {
  const oppositeDirection = direction === "INGRESO" ? "EGRESO" : "INGRESO";
  const result: RegimenDocumentSummary = {
    version: 1, periodo: input.period, estado: "PENDIENTE", usadaEnCalculoAutomatico: false,
    totales: null, porRegimen: null,
    renglones: [], pendientes: [], duplicadosOmitidos: 0,
  };
  const issueKeys = new Set<string>();
  const issueIds = new Set<string>();
  const issue = (id: string, code: RegimenDocumentIssueCode) => {
    const key = `${id}:${code}`;
    if (!issueKeys.has(key)) { issueKeys.add(key); issueIds.add(id); result.pendientes.push({ id, code }); }
  };
  if (!/^(20\d{2}|2100)-(0[1-9]|1[0-2])$/.test(input.period)) {
    issue("periodo", "INVALID_PERIOD");
    return result;
  }
  const [year, month] = input.period.split("-").map(Number);
  const from = Date.UTC(year, month - 1, 1), to = Date.UTC(year, month, 1);
  const inMonth = (date: string | null) => timestamp(date) >= from && timestamp(date) < to;
  if (input.truncated) {
    issue("periodo", "EVIDENCE_LIMIT_EXCEEDED");
    return result; // Never summarize a silently truncated ledger/evidence set.
  }
  if (input.regimenCodes.length === 0) issue("periodo", "NO_PAYMENT_REGIME_EVIDENCE");
  if (input.regimenCodes.some((code) => !VALID_REGIMENES.has(code))) issue("periodo", "UNKNOWN_PAYMENT_REGIME");
  for (const id of input.linkedCreditNoteIds) issue(id, "CREDIT_NOTE_REVIEW");

  const invoices = new Map<string, RegimenInvoiceEvidence[]>();
  const byId = new Map<string, RegimenInvoiceEvidence>();
  for (const invoice of [...input.issued, ...input.parents]) {
    if (byId.has(invoice.id)) {
      if (JSON.stringify(byId.get(invoice.id)) !== JSON.stringify(invoice)) issue(invoice.id, "AMBIGUOUS_INVOICE_UUID");
      continue;
    }
    byId.set(invoice.id, invoice);
    if (!invoice.uuid?.trim()) continue;
    const uuid = normalizarUuid(invoice.uuid);
    invoices.set(uuid, [...(invoices.get(uuid) ?? []), invoice]);
  }
  const netBase = (invoice: RegimenInvoiceEvidence): number | null => {
    if (issueIds.has(invoice.id)) return null; // Conflicting copies cannot produce a valid preview.
    if (!invoice.uuid?.trim()) { issue(invoice.id, "MISSING_INVOICE_UUID"); return null; }
    if ((invoices.get(normalizarUuid(invoice.uuid))?.length ?? 0) > 1) {
      issue(invoice.id, "AMBIGUOUS_INVOICE_UUID"); return null;
    }
    if (invoice.tipoSat !== "I") { issue(invoice.id, invoice.tipoSat === "E" ? "CREDIT_NOTE_REVIEW" : "UNSUPPORTED_DOCUMENT"); return null; }
    if (!Number.isFinite(timestamp(invoice.fecha))) { issue(invoice.id, "INVALID_INVOICE_DATE"); return null; }
    if (invoice.moneda.trim().toUpperCase() !== "MXN") { issue(invoice.id, "FOREIGN_CURRENCY_REVIEW"); return null; }
    if (!validMicros(invoice.subtotalMicros) || !validMicros(invoice.descuentoMicros)
      || !validMicros(invoice.totalMicros) || invoice.descuentoMicros > invoice.subtotalMicros) {
      issue(invoice.id, "INVALID_INVOICE_AMOUNTS"); return null;
    }
    return invoice.subtotalMicros - invoice.descuentoMicros;
  };
  const project = (invoice: RegimenInvoiceEvidence, cents: number) => projectRegimenBase({
    baseCentavos: cents, parentEffectiveRegimenCodes: invoice.regimenCodes,
    paymentEffectiveRegimenCodes: input.regimenCodes, assignment: invoice.assignment,
  });

  // PUE is an emission-month documentary bucket, explicitly NOT proof of cash.
  const issuedIds = new Set(input.issued.map((invoice) => invoice.id));
  for (const invoice of byId.values()) {
    if (!issuedIds.has(invoice.id) || invoice.status !== "STAMPED" || invoice.supersededBy || invoice.tipo !== direction) continue;
    if (!Number.isFinite(timestamp(invoice.fecha))) { issue(invoice.id, "INVALID_INVOICE_DATE"); continue; }
    if (!inMonth(invoice.fecha)) continue;
    if (invoice.tipoSat === "E") { issue(invoice.id, "CREDIT_NOTE_REVIEW"); continue; }
    if (invoice.metodoPago === "PPD") continue; // Count only its REP, never the invoice again.
    if (invoice.metodoPago !== "PUE") { issue(invoice.id, "UNSUPPORTED_PAYMENT_METHOD"); continue; }
    const net = netBase(invoice);
    if (net === null) continue;
    const projection = project(invoice, roundMicros(net));
    if (!projection.ok) { issue(invoice.id, projection.code); continue; }
    result.renglones.push({
      invoiceId: invoice.id, uuid: normalizarUuid(invoice.uuid!), source: "PUE_DOCUMENTADO",
      assignmentRevision: invoice.assignment?.revision ?? null, baseCentavos: projection.baseCentavos,
      allocations: projection.allocations.map(({ regimenCode, amountCentavos }) => ({ regimenCode, amountCentavos })),
      evidenceIds: [invoice.id],
    });
  }

  const deduplicate = (payments: RegimenPaymentEvidence[], countDuplicates: boolean) => {
    const unique = new Map<string, RegimenPaymentEvidence>();
    for (const payment of payments) {
      if (payment.status !== "STAMPED" || payment.supersededBy) continue;
      if (!payment.repUuid?.trim()) { issue(payment.id, "MISSING_REP_UUID"); continue; }
      const key = paymentKey(payment), previous = unique.get(key);
      if (previous && paymentSignature(previous) !== paymentSignature(payment)) issue(key, "DUPLICATE_PAYMENT_CONFLICT");
      else if (previous && countDuplicates) result.duplicadosOmitidos++;
      // Stable provenance regardless of query/input order.
      if (!previous || payment.id < previous.id) unique.set(key, payment);
    }
    return unique;
  };
  const directionCandidate = (p: RegimenPaymentEvidence) => {
    const matches = invoices.get(normalizarUuid(p.parentUuid)) ?? [];
    return !(matches.length === 1 && matches[0].tipo === oppositeDirection);
  };
  const current = deduplicate(input.payments.filter(directionCandidate), true);
  const history = deduplicate(input.history.filter(directionCandidate), false);
  const historyByParent = new Map<string, RegimenPaymentEvidence[]>();
  for (const payment of history.values()) {
    const uuid = normalizarUuid(payment.parentUuid);
    const rows = historyByParent.get(uuid) ?? [];
    rows.push(payment);
    historyByParent.set(uuid, rows);
  }
  const currentByParent = new Map<string, RegimenPaymentEvidence[]>();
  for (const payment of current.values()) {
    const uuid = normalizarUuid(payment.parentUuid);
    const matches = invoices.get(uuid) ?? [];
    // Resolved opposite-direction payments are outside this summary, not omissions.
    if (matches.length === 1 && matches[0].tipo === oppositeDirection) continue;
    if (!Number.isFinite(timestamp(payment.fechaPago))) { issue(payment.id, "PAYMENT_DATE_UNAVAILABLE"); continue; }
    if (!inMonth(payment.fechaPago)) continue;
    if (matches.length !== 1) { issue(payment.id, matches.length ? "AMBIGUOUS_INVOICE_UUID" : "PARENT_NOT_FOUND"); continue; }
    const parent = matches[0];
    if (parent.tipo !== direction || parent.status !== "STAMPED" || parent.supersededBy || parent.metodoPago !== "PPD") {
      issue(payment.id, "PARENT_NOT_ELIGIBLE"); continue;
    }
    currentByParent.set(uuid, [...(currentByParent.get(uuid) ?? []), payment]);
  }

  for (const [uuid, payments] of currentByParent) {
    const invoice = invoices.get(uuid)![0];
    const net = netBase(invoice);
    if (net === null) continue;
    const all = historyByParent.get(uuid) ?? [];
    const installments = new Set<number>();
    for (const payment of all) {
      if (!Number.isFinite(timestamp(payment.fechaPago))) issue(payment.id, "PAYMENT_DATE_UNAVAILABLE");
      else if (timestamp(payment.fechaPago) < timestamp(invoice.fecha)) issue(payment.id, "PAYMENT_BEFORE_INVOICE");
      if (payment.installment === null || !Number.isSafeInteger(payment.installment) || payment.installment < 1) {
        issue(payment.id, "PAYMENT_INSTALLMENT_UNAVAILABLE");
      } else {
        if (installments.has(payment.installment)) issue(invoice.id, "DUPLICATE_INSTALLMENT");
        installments.add(payment.installment);
      }
    }
    if ([...installments].sort((a, b) => a - b).some((number, index) => number !== index + 1)) {
      issue(invoice.id, "PAYMENT_HISTORY_GAP");
    }
    const expectedKeys = all.filter((p) => inMonth(p.fechaPago)).map(paymentKey).sort();
    const actualKeys = payments.map(paymentKey).sort();
    if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)
      || payments.some((p) => paymentSignature(p) !== paymentSignature(history.get(paymentKey(p)) ?? p) || !history.has(paymentKey(p)))) {
      issue(invoice.id, "PAYMENT_SNAPSHOT_MISMATCH");
    }
    const integrity = validatePpdPaymentHistory({
      parentTotalMicropesos: invoice.totalMicros!, paymentAmountsMicropesos: all.map((p) => p.amountMicros),
    });
    if (!integrity.ok) issue(invoice.id, integrity.code);
    // An issue discovered during deduplication/current selection still blocks
    // this parent's row, even if revalidation only repeats that same issue.
    const paymentHasIssue = (p: RegimenPaymentEvidence) => issueIds.has(p.id) || issueIds.has(paymentKey(p));
    if (!integrity.ok || issueIds.has(invoice.id) || all.some(paymentHasIssue) || payments.some(paymentHasIssue)) continue;

    const sumBefore = (end: number) => Number(all.filter((p) => timestamp(p.fechaPago) < end)
      .reduce((sum, p) => sum + BigInt(p.amountMicros!), BigInt(0)));
    const baseAt = (paid: number) => paid === 0 ? { ok: true as const, amount: 0 } : proratePpdBaseCentavos({
      impPagadoMicropesos: paid, parentSubtotalMicropesos: net, parentTotalMicropesos: invoice.totalMicros!,
    });
    const before = baseAt(sumBefore(from)), through = baseAt(sumBefore(to));
    if (!before.ok || !through.ok) { issue(invoice.id, !before.ok ? before.code : !through.ok ? through.code : "INVALID_PAYMENT_BASE"); continue; }
    const start = project(invoice, before.amount), end = project(invoice, through.amount);
    if (!start.ok || !end.ok) { issue(invoice.id, !start.ok ? start.code : !end.ok ? end.code : "INVALID_PAYMENT_BASE"); continue; }
    const amountsBefore = new Map(start.allocations.map((a) => [a.regimenCode, a.amountCentavos]));
    const allocations = end.allocations.map((a) => ({
      regimenCode: a.regimenCode, amountCentavos: a.amountCentavos - (amountsBefore.get(a.regimenCode) ?? 0),
    }));
    // Largest remainder is not monotone for every 3+ regime split. Never turn a
    // residual-cent reversal into a negative documentary base; require explicit review.
    if (allocations.some((a) => a.amountCentavos < 0)) { issue(invoice.id, "CUMULATIVE_ROUNDING_REVIEW"); continue; }
    result.renglones.push({
      invoiceId: invoice.id, uuid, source: "PPD_REP", assignmentRevision: invoice.assignment?.revision ?? null,
      baseCentavos: through.amount - before.amount, allocations,
      evidenceIds: payments.map((p) => p.id).sort(),
    });
  }

  result.renglones.sort((a, b) => a.uuid.localeCompare(b.uuid) || a.source.localeCompare(b.source));
  result.pendientes.sort((a, b) => a.id.localeCompare(b.id) || a.code.localeCompare(b.code));
  if (result.pendientes.length) return result;
  if (!result.renglones.length) { result.estado = "SIN_EVIDENCIA"; return result; }
  const groups = new Map<string, { pue: bigint; ppd: bigint }>();
  let pue = BigInt(0), ppd = BigInt(0);
  for (const row of result.renglones) {
    if (row.source === "PUE_DOCUMENTADO") pue += BigInt(row.baseCentavos); else ppd += BigInt(row.baseCentavos);
    for (const allocation of row.allocations) {
      const group = groups.get(allocation.regimenCode) ?? { pue: BigInt(0), ppd: BigInt(0) };
      if (row.source === "PUE_DOCUMENTADO") group.pue += BigInt(allocation.amountCentavos); else group.ppd += BigInt(allocation.amountCentavos);
      groups.set(allocation.regimenCode, group);
    }
  }
  if (pue + ppd > BigInt(Number.MAX_SAFE_INTEGER)) { issue("periodo", "UNSAFE_AGGREGATE"); return result; }
  result.estado = "PROYECTABLE";
  result.totales = { pueDocumentadoCentavos: Number(pue), ppdRepCentavos: Number(ppd) };
  result.porRegimen = [...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([regimenCode, values]) => ({ regimenCode, pueDocumentadoCentavos: Number(values.pue), ppdRepCentavos: Number(values.ppd) }));
  return result;
}
