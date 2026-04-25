/**
 * GET /api/construccion/bank-accounts?companyId=... [&withBalances=true]
 *
 * Thin bearer-aware wrapper so bartiz can list a company's bank accounts
 * for the anticipo and payment forms. The main /api/bancos endpoint uses
 * session-cookie auth and isn't bearer-compatible.
 *
 * When withBalances=true, attaches `balance` (sum of monto across all
 * txs) and `flow30d` (sum of monto for txs in the last 30 days) to each
 * account. Drives the Tesorería page header without N additional
 * round-trips. Skipped by default to keep the form-fill use case fast.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

const round2 = (n: number) => Math.round(n * 100) / 100;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const withBalances = searchParams.get("withBalances") === "true";
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "CONSTRUCCION");

  const accounts = await prisma.bankAccount.findMany({
    where: { companyId },
    select: {
      id: true,
      banco: true,
      nombre: true,
      numeroCuenta: true,
      moneda: true,
      tipo: true,
      titular: true,
    },
    orderBy: [{ tipo: "asc" }, { nombre: "asc" }],
  });

  if (!withBalances) return NextResponse.json(accounts);

  // Single grouped query rather than N per-account aggregates
  const allBalances = await prisma.bankTransaction.groupBy({
    by: ["bankAccountId"],
    where: { companyId },
    _sum: { monto: true },
    _count: true,
  });
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const recent = await prisma.bankTransaction.groupBy({
    by: ["bankAccountId"],
    where: { companyId, fecha: { gte: since } },
    _sum: { monto: true },
  });
  const balanceMap = new Map(
    allBalances.map((r) => [r.bankAccountId, { total: r._sum.monto ?? 0, count: r._count }])
  );
  const recentMap = new Map(
    recent.map((r) => [r.bankAccountId, r._sum.monto ?? 0])
  );

  const enriched = accounts.map((a) => ({
    ...a,
    balance: round2(balanceMap.get(a.id)?.total ?? 0),
    transactionCount: balanceMap.get(a.id)?.count ?? 0,
    flow30d: round2(recentMap.get(a.id) ?? 0),
  }));

  return NextResponse.json(enriched);
});
