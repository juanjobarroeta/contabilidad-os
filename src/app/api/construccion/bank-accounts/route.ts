/**
 * GET /api/construccion/bank-accounts?companyId=...
 *
 * Thin bearer-aware wrapper so bartiz can list a company's bank accounts
 * for the anticipo and payment forms. The main /api/bancos endpoint uses
 * session-cookie auth and isn't bearer-compatible.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
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
    },
    orderBy: { nombre: "asc" },
  });

  return NextResponse.json(accounts);
});
