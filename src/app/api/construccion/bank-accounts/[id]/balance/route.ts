/**
 * GET /api/construccion/bank-accounts/[id]/balance
 *
 * Current balance = sum of BankTransaction.monto for this account.
 * Credits are positive, debits are negative in the schema, so a simple
 * sum works. Used by the Gastos page to show the caja chica balance.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireMembership,
  requireModule,
  withAuthz,
} from "@/lib/authz";

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const account = await prisma.bankAccount.findUnique({
      where: { id },
      select: { id: true, companyId: true },
    });
    if (!account) throw new AuthzError(404, "BankAccount no encontrado");
    await requireMembership(account.companyId, undefined, req);
    await requireModule(account.companyId, "CONSTRUCCION");

    const agg = await prisma.bankTransaction.aggregate({
      where: { bankAccountId: id },
      _sum: { monto: true },
      _count: true,
    });
    const balance = Math.round(Number(agg._sum.monto ?? 0) * 100) / 100;
    return NextResponse.json({ balance, transactionCount: agg._count });
  }
);
