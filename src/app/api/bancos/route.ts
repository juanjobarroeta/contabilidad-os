import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership, requireUser, AuthzError } from "@/lib/authz";

// GET /api/bancos?companyId=xxx
// Autz: sesión web O token de servicio (Authorization: Bearer <jwt>), para que
// ZionX (app satélite) pueda espejear cuentas y movimientos bancarios.
export async function GET(req: Request) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const accounts = await prisma.bankAccount.findMany({
    where: { companyId },
    include: {
      _count: { select: { transactions: true } },
      transactions: {
        orderBy: { fecha: "desc" },
        take: 1,
        select: { fecha: true, saldo: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // Compute stats per account
  const withStats = await Promise.all(accounts.map(async (acc) => {
    const stats = await prisma.bankTransaction.groupBy({
      by: ["status"],
      where: { bankAccountId: acc.id },
      _count: true,
    });
    const statMap = Object.fromEntries(stats.map(s => [s.status, s._count]));
    return {
      ...acc,
      lastTransaction: acc.transactions[0] ?? null,
      stats: {
        total: acc._count.transactions,
        unmatched: statMap.UNMATCHED ?? 0,
        matched: statMap.MATCHED ?? 0,
        ignored: statMap.IGNORED ?? 0,
      },
    };
  }));

  return NextResponse.json(withStats);
}

// POST /api/bancos — create a bank account
export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { companyId, banco, nombre, numeroCuenta, clabe, moneda } = await req.json();
  if (!companyId || !banco || !nombre || !numeroCuenta) {
    return NextResponse.json({ error: "Faltan campos requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  try {
    const account = await prisma.bankAccount.create({
      data: { companyId, banco, nombre, numeroCuenta, clabe, moneda: moneda ?? "MXN" },
    });
    return NextResponse.json(account, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Ya existe una cuenta con ese número" }, { status: 409 });
  }
}
