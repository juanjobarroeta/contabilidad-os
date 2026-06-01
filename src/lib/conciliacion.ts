import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Bank reconciliation helpers, shared by the web bancos page and the WhatsApp
// conciliación flow. Scoring mirrors /api/bancos/[id]/match (amount + date +
// RFC). Matching is a guided write — over WhatsApp it's gated by confirmation.
// ─────────────────────────────────────────────────────────────────────────────

const WINDOW_DAYS = 30;
const TOLERANCE = 0.05;

export interface MatchCandidate {
  invoiceId: string;
  uuid: string | null;
  fecha: string;
  total: number;
  tipo: string;
  cliente: string;
  rfc: string;
  metodoPago: string;
  score: number;
  confidence: "alta" | "media" | "baja";
}

/** Score candidate invoices for a single bank transaction. */
export async function scoreCandidates(txId: string, companyId: string): Promise<{
  tx: { id: string; fecha: string; descripcion: string; monto: number } | null;
  candidates: MatchCandidate[];
}> {
  const tx = await prisma.bankTransaction.findFirst({
    where: { id: txId, companyId },
  });
  if (!tx) return { tx: null, candidates: [] };

  const absAmount = Math.abs(tx.monto);
  // Incoming deposit → income CFDIs: INGRESO you issued, OR a NOMINA you
  // RECEIVED (asimilados/sueldos paid to you — a real income deposit).
  // Outgoing debit → expense CFDIs: EGRESO, OR a NOMINA you issued as employer.
  const incomingTypes = ["INGRESO", "NOMINA"] as const;
  const outgoingTypes = ["EGRESO", "NOMINA"] as const;
  const tipoIn = tx.monto > 0 ? [...incomingTypes] : [...outgoingTypes];

  const invoices = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo: { in: tipoIn },
      status: "STAMPED",
      fecha: {
        gte: new Date(tx.fecha.getTime() - WINDOW_DAYS * 86400000),
        lte: new Date(tx.fecha.getTime() + WINDOW_DAYS * 86400000),
      },
      total: { gte: absAmount * (1 - TOLERANCE), lte: absAmount * (1 + TOLERANCE) },
      OR: [{ metodoPago: "PPD" }, { bankTransactions: { none: { status: "MATCHED" } } }],
    },
    include: { customer: { select: { rfc: true, razonSocial: true } } },
    orderBy: { fecha: "desc" },
    take: 10,
  });

  const candidates: MatchCandidate[] = invoices
    .map((inv) => {
      let score = 0;
      const diff = Math.abs(Math.abs(inv.total) - absAmount);
      if (diff < 0.01) score += 100;
      else if (diff / absAmount < 0.005) score += 70;
      else if (diff / absAmount < 0.01) score += 40;
      else if (diff / absAmount < TOLERANCE) score += 20;
      const daysDiff = Math.abs(inv.fecha.getTime() - tx.fecha.getTime()) / 86400000;
      if (daysDiff <= 1) score += 30;
      else if (daysDiff <= 3) score += 20;
      else if (daysDiff <= 7) score += 10;
      const rfc = inv.customer?.rfc ?? "";
      if (rfc && tx.descripcion.toUpperCase().includes(rfc)) score += 25;
      return {
        invoiceId: inv.id,
        uuid: inv.uuid,
        fecha: inv.fecha.toISOString().slice(0, 10),
        total: inv.total,
        tipo: inv.tipo,
        cliente: inv.customer?.razonSocial ?? "—",
        rfc: inv.customer?.rfc ?? "—",
        metodoPago: inv.metodoPago,
        score,
        confidence: (score >= 100 ? "alta" : score >= 50 ? "media" : "baja") as MatchCandidate["confidence"],
      };
    })
    .sort((a, b) => b.score - a.score);

  return {
    tx: {
      id: tx.id,
      fecha: tx.fecha.toISOString().slice(0, 10),
      descripcion: tx.descripcion,
      monto: tx.monto,
    },
    candidates,
  };
}

export interface UnmatchedTx {
  id: string;
  fecha: string;
  descripcion: string;
  monto: number;
  banco: string;
  topCandidate: MatchCandidate | null;
}

/** List unmatched transactions for a company, each with its best candidate. */
export async function listUnmatched(companyId: string, limit = 10): Promise<{
  total: number;
  transactions: UnmatchedTx[];
}> {
  const total = await prisma.bankTransaction.count({
    where: { companyId, status: "UNMATCHED" },
  });
  const txs = await prisma.bankTransaction.findMany({
    where: { companyId, status: "UNMATCHED" },
    include: { bankAccount: { select: { banco: true } } },
    orderBy: { fecha: "desc" },
    take: limit,
  });

  const transactions: UnmatchedTx[] = [];
  for (const tx of txs) {
    const { candidates } = await scoreCandidates(tx.id, companyId);
    transactions.push({
      id: tx.id,
      fecha: tx.fecha.toISOString().slice(0, 10),
      descripcion: tx.descripcion,
      monto: tx.monto,
      banco: tx.bankAccount?.banco ?? "—",
      topCandidate: candidates[0] ?? null,
    });
  }
  return { total, transactions };
}

export type ReconcileResult =
  | { ok: true; uuid: string | null; cliente: string }
  | { ok: false; error: string };

/** Persist a match: BankTransaction → Invoice (status MATCHED). */
export async function reconcileTransaction(
  txId: string,
  invoiceId: string,
  companyId: string
): Promise<ReconcileResult> {
  const [tx, inv] = await Promise.all([
    prisma.bankTransaction.findFirst({ where: { id: txId, companyId }, select: { id: true } }),
    prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      select: { id: true, uuid: true, customer: { select: { razonSocial: true } } },
    }),
  ]);
  if (!tx) return { ok: false, error: "Movimiento no encontrado." };
  if (!inv) return { ok: false, error: "Factura no encontrada." };

  await prisma.bankTransaction.update({
    where: { id: txId },
    data: { status: "MATCHED", invoiceId },
  });
  return { ok: true, uuid: inv.uuid, cliente: inv.customer?.razonSocial ?? "—" };
}
