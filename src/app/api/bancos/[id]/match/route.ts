import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

type Params = { params: Promise<{ id: string }> };

// POST /api/bancos/[id]/match — run auto-matching engine
export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: bankAccountId } = await params;
  const account = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!account) return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, account.companyId);
  if (!member || member.role === "VIEWER") return NextResponse.json({ error: "Sin permisos" }, { status: 403 });

  const companyId = account.companyId;
  const WINDOW_DAYS = 14;
  const TOLERANCE  = 0.01; // 1%

  const unmatched = await prisma.bankTransaction.findMany({
    where: { bankAccountId, status: "UNMATCHED" },
  });

  let autoMatched = 0;

  for (const tx of unmatched) {
    const absAmount = Math.abs(tx.monto);
    const isCreditTx = tx.monto > 0;

    // CREDITs (money in) → match against INGRESO invoices (customers paying us)
    // DEBITs  (money out) → match against EGRESO invoices  (us paying suppliers)
    const invoiceType = isCreditTx ? "INGRESO" : "EGRESO";

    const windowStart = new Date(tx.fecha.getTime() - WINDOW_DAYS * 86400000);
    const windowEnd   = new Date(tx.fecha.getTime() + WINDOW_DAYS * 86400000);

    const candidates = await prisma.invoice.findMany({
      where: {
        companyId,
        tipo:   invoiceType,
        status: "STAMPED",
        fecha:  { gte: windowStart, lte: windowEnd },
        total:  { gte: absAmount * (1 - TOLERANCE), lte: absAmount * (1 + TOLERANCE) },
        // Not already matched to another bank transaction
        bankTransactions: { none: { status: "MATCHED" } },
      },
      include: { customer: { select: { rfc: true, razonSocial: true } } },
    });

    if (candidates.length === 0) continue;

    // Score each candidate
    const scored = candidates.map(inv => {
      let score = 0;
      const diff = Math.abs(Math.abs(inv.total) - absAmount);
      // Amount scoring
      if (diff < 0.01)                           score += 100; // exact
      else if (diff / absAmount < 0.005)          score += 70;  // <0.5%
      else if (diff / absAmount < TOLERANCE)      score += 40;  // <1%
      // Date proximity
      const daysDiff = Math.abs(inv.fecha.getTime() - tx.fecha.getTime()) / 86400000;
      if (daysDiff <= 1)  score += 30;
      else if (daysDiff <= 3)  score += 20;
      else if (daysDiff <= 7)  score += 10;
      // RFC in description
      const rfc = inv.customer?.rfc ?? "";
      if (rfc && tx.descripcion.toUpperCase().includes(rfc)) score += 25;
      return { inv, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    // Auto-apply only when confidence is very high AND unambiguous:
    // - Score ≥ 130 (exact amount + date within 7d)
    // - No other candidate within 20 points of the winner (avoids wrong match
    //   when multiple invoices have the same amount)
    const secondBest = scored[1];
    const unambiguous = !secondBest || (best.score - secondBest.score) >= 20;

    if (best.score >= 130 && unambiguous) {
      await prisma.bankTransaction.update({
        where: { id: tx.id },
        data: { status: "MATCHED", invoiceId: best.inv.id },
      });
      autoMatched++;
    }
  }

  return NextResponse.json({ ok: true, autoMatched, total: unmatched.length });
}

// GET /api/bancos/[id]/match?txId=xxx — get match candidates for a specific transaction
export async function GET(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: bankAccountId } = await params;
  const txId = new URL(req.url).searchParams.get("txId");
  if (!txId) return NextResponse.json({ error: "txId requerido" }, { status: 400 });

  const account = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!account) return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, account.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const tx = await prisma.bankTransaction.findUnique({ where: { id: txId } });
  if (!tx) return NextResponse.json({ error: "Transacción no encontrada" }, { status: 404 });

  const companyId   = account.companyId;
  const absAmount   = Math.abs(tx.monto);
  const isCreditTx  = tx.monto > 0;
  const invoiceType = isCreditTx ? "INGRESO" : "EGRESO";
  const WINDOW_DAYS = 30;
  const TOLERANCE   = 0.05; // 5% for suggestions (wider than auto-match)

  const candidates = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo:   invoiceType,
      status: "STAMPED",
      fecha:  {
        gte: new Date(tx.fecha.getTime() - WINDOW_DAYS * 86400000),
        lte: new Date(tx.fecha.getTime() + WINDOW_DAYS * 86400000),
      },
      total: { gte: absAmount * (1 - TOLERANCE), lte: absAmount * (1 + TOLERANCE) },
      // Exclude PUE invoices already matched to another bank tx.
      // Keep PPD invoices visible — they can have multiple partial payments.
      OR: [
        { metodoPago: "PPD" },
        { bankTransactions: { none: { status: "MATCHED" } } },
      ],
    },
    include: {
      customer: { select: { rfc: true, razonSocial: true } },
      bankTransactions: {
        where: { status: "MATCHED" },
        select: { id: true, fecha: true, monto: true },
      },
    },
    orderBy: { fecha: "desc" },
    take: 10,
  });

  const scored = candidates.map(inv => {
    let score = 0;
    const diff = Math.abs(Math.abs(inv.total) - absAmount);
    if (diff < 0.01)                          score += 100;
    else if (diff / absAmount < 0.005)         score += 70;
    else if (diff / absAmount < 0.01)          score += 40;
    else if (diff / absAmount < TOLERANCE)     score += 20;
    const daysDiff = Math.abs(inv.fecha.getTime() - tx.fecha.getTime()) / 86400000;
    if (daysDiff <= 1)       score += 30;
    else if (daysDiff <= 3)  score += 20;
    else if (daysDiff <= 7)  score += 10;
    const rfc = inv.customer?.rfc ?? "";
    if (rfc && tx.descripcion.toUpperCase().includes(rfc)) score += 25;
    const alreadyMatched = inv.bankTransactions.length > 0;
    // Neto firmado: un reembolso (cargo) resta de lo cobrado.
    const matchedAmount = Math.abs(inv.bankTransactions.reduce((s, t) => s + t.monto, 0));
    return {
      id:          inv.id,
      uuid:        inv.uuid,
      fecha:       inv.fecha,
      folio:       inv.folio,
      serie:       inv.serie,
      metodoPago:  inv.metodoPago,
      total:       inv.total,
      cliente:     inv.customer?.razonSocial ?? "—",
      rfc:         inv.customer?.rfc ?? "—",
      score,
      confidence:  score >= 100 ? "alta" : score >= 50 ? "media" : "baja",
      alreadyMatched,
      matchedAmount: Math.round(matchedAmount * 100) / 100,
      remainingBalance: Math.round((inv.total - matchedAmount) * 100) / 100,
    };
  }).sort((a, b) => b.score - a.score);

  return NextResponse.json({ transaction: tx, candidates: scored });
}
