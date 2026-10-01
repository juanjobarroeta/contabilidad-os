import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { RegimenDocumentInput, RegimenDocumentRow } from "./regimen-document-bases";
import { normalizarUuid } from "./uuid";
import { compareRepPayment, parseRepPaymentEvidence, REP_CHECK_VERSION, REP_XML_MAX_BYTES, type ParsedRep, type RepPaymentCheck } from "./rep-payment-evidence";

export const REP_CHECK_MAX_DOCUMENTS = 256;
export const REP_CHECK_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export const REP_CHECK_PREVIEW = 25;
export const repXmlWithinBudget = (documents: number, sizes: number[]) => documents <= REP_CHECK_MAX_DOCUMENTS
  && sizes.every((size) => Number.isSafeInteger(size) && size >= 0 && size <= REP_XML_MAX_BYTES)
  && sizes.reduce((total, size) => total + size, 0) <= REP_CHECK_MAX_TOTAL_BYTES;
type Payment = { relationId: string; repInvoiceId: string | null; repUuid: string | null; xmlHash: string | null;
  enPeriodo: boolean; cotejo: RepPaymentCheck };
export type DeductionPaymentEvidence = {
  version: string; estado: "PUE_SIN_ACREDITAR" | "REP_COTEJADO" | "REP_PENDIENTE";
  comprobacionBancaria: false; deduccionAutorizadaCentavos: null;
  totalRelaciones: number; relacionesEnPeriodo: number; pendientes: number; vistaLimitada: boolean; pagos: Payment[];
};
type Metadata = { id: string; bytes: number; updatedAt: Date };

/** Called only inside the authorized review transaction. No imports, repairs or provider IO. */
export async function readDeductionPaymentEvidence(tx: Prisma.TransactionClient, companyId: string, companyRfc: string,
  input: RegimenDocumentInput, rows: RegimenDocumentRow[]) {
  const invoices = new Map([...input.parents, ...input.issued].map((invoice) => [invoice.id, invoice]));
  const candidates = new Map(rows.filter((row) => row.source === "PPD_REP").map((row) => [row.uuid, row]));
  const relations = [...new Map([...input.history, ...input.payments]
    .filter((payment) => candidates.has(normalizarUuid(payment.parentUuid)))
    .map((payment) => [payment.id, payment])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const ids = [...new Set(relations.flatMap((payment) => payment.repInvoiceId ? [payment.repInvoiceId] : []))].sort();
  // Inspect sizes before retrieving any XML. The original 5,000-row sentinel
  // remains in force; this additional budget bounds XML memory and parse work.
  const metadata = ids.length ? await tx.$queryRaw<Metadata[]>(Prisma.sql`
    SELECT id, COALESCE(octet_length("rawXml"), 0)::integer AS bytes, "updatedAt"
    FROM "Invoice" WHERE "companyId" = ${companyId} AND id IN (${Prisma.join(ids)}) ORDER BY id
  `) : [];
  const limited = !repXmlWithinBudget(ids.length, metadata.map((row) => row.bytes));
  const xmlRows = ids.length && !limited ? await tx.invoice.findMany({
    where: { companyId, id: { in: ids } }, select: { id: true, rawXml: true }, orderBy: { id: "asc" },
  }) : [];
  const parsed = new Map<string, { hash: string | null; value: ParsedRep }>(xmlRows.map((row) => [row.id, {
    hash: row.rawXml === null ? null : createHash("sha256").update(row.rawXml).digest("hex"),
    value: parseRepPaymentEvidence(row.rawXml),
  }]));
  const checks = relations.map((payment) => {
    const row = candidates.get(normalizarUuid(payment.parentUuid))!;
    const source = payment.repInvoiceId ? parsed.get(payment.repInvoiceId) : undefined;
    const value: ParsedRep = limited ? { ok: false, reason: "XML_LIMIT" } : source?.value ?? { ok: false, reason: "XML_MISSING" };
    return { invoiceId: row.invoiceId, relationId: payment.id, repInvoiceId: payment.repInvoiceId ?? null,
      repUuid: payment.repUuid, xmlHash: source?.hash ?? null, enPeriodo: row.evidenceIds.includes(payment.id),
      cotejo: compareRepPayment(value, payment, companyRfc, invoices.get(row.invoiceId)?.supplierRfc ?? null) };
  });
  const byInvoice = new Map<string, DeductionPaymentEvidence>();
  for (const row of rows) {
    const payments = checks.filter((payment) => payment.invoiceId === row.invoiceId);
    const pending = payments.filter((payment) => payment.cotejo.estado !== "COTEJADO").length;
    const complete = payments.length > 0 && !pending && row.evidenceIds.every((id) => payments.some((payment) => payment.relationId === id));
    byInvoice.set(row.invoiceId, { version: REP_CHECK_VERSION,
      estado: row.source === "PUE_DOCUMENTADO" ? "PUE_SIN_ACREDITAR" : complete ? "REP_COTEJADO" : "REP_PENDIENTE",
      comprobacionBancaria: false, deduccionAutorizadaCentavos: null,
      totalRelaciones: payments.length, relacionesEnPeriodo: payments.filter((payment) => payment.enPeriodo).length,
      pendientes: pending, vistaLimitada: payments.length > REP_CHECK_PREVIEW,
      pagos: payments.sort((a, b) => Number(b.cotejo.estado === "PENDIENTE") - Number(a.cotejo.estado === "PENDIENTE")
        || Number(b.enPeriodo) - Number(a.enPeriodo) || a.relationId.localeCompare(b.relationId))
        .slice(0, REP_CHECK_PREVIEW).map(({ invoiceId: _invoiceId, ...payment }) => payment),
    });
  }
  // Hash all inspected sources, not only visible previews. Metadata tracks even
  // over-budget sources; successful checks additionally fingerprint exact XML.
  return { byInvoice, fingerprint: { version: REP_CHECK_VERSION, limited, metadata, checks } };
}
