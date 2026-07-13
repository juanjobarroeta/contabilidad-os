/**
 * GET /api/restaurante/bank-accounts?companyId=...
 *
 * Thin bearer-aware wrapper so restauranteos can list a company's bank
 * accounts for the charge / pago-de-compra forms (TRANSFERENCIA / TARJETA
 * need a destination account). Mirrors /api/construccion/bank-accounts.
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
  await requireModule(companyId, "RESTAURANTE", req);

  const accounts = await prisma.bankAccount.findMany({
    where: { companyId },
    select: {
      id: true,
      banco: true,
      nombre: true,
      numeroCuenta: true,
      moneda: true,
      tipo: true,
    },
    orderBy: [{ tipo: "asc" }, { nombre: "asc" }],
  });

  return NextResponse.json(accounts);
});
