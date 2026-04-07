import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

type Params = { params: Promise<{ id: string }> };

// GET /api/bancos/[id]?status=UNMATCHED|MATCHED|IGNORED|PENDING&page=1&pageSize=50
// PENDING = IGNORED rows with notes = "PENDING_MONTHLY_CFDI" (bank fees waiting
// for the consolidated monthly CFDI from the bank).
export async function GET(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: bankAccountId } = await params;
  const { searchParams } = new URL(req.url);
  const status   = searchParams.get("status") ?? undefined;
  const page     = parseInt(searchParams.get("page") ?? "1");
  const pageSize = parseInt(searchParams.get("pageSize") ?? "50");

  const account = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!account) return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });

  const member = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: session.user.id, companyId: account.companyId } },
  });
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  let where: Prisma.BankTransactionWhereInput = { bankAccountId };
  if (status === "PENDING") {
    where = { bankAccountId, status: "IGNORED", notes: "PENDING_MONTHLY_CFDI" };
  } else if (status === "IGNORED") {
    // Exclude pending-CFDI rows from the plain Ignorados tab so they don't clutter it
    where = { bankAccountId, status: "IGNORED", NOT: { notes: "PENDING_MONTHLY_CFDI" } };
  } else if (status) {
    where = { bankAccountId, status: status as "UNMATCHED" | "MATCHED" | "IGNORED" };
  }

  const [transactions, total] = await Promise.all([
    prisma.bankTransaction.findMany({
      where,
      include: {
        invoice: {
          select: { id: true, uuid: true, total: true, fecha: true, customer: { select: { razonSocial: true } } },
        },
      },
      orderBy: { fecha: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.bankTransaction.count({ where }),
  ]);

  // Status counts — compute PENDING separately
  const [counts, pendingCount] = await Promise.all([
    prisma.bankTransaction.groupBy({
      by: ["status"],
      where: { bankAccountId },
      _count: true,
    }),
    prisma.bankTransaction.count({
      where: { bankAccountId, status: "IGNORED", notes: "PENDING_MONTHLY_CFDI" },
    }),
  ]);
  const statusCounts = Object.fromEntries(counts.map(c => [c.status, c._count]));

  return NextResponse.json({
    account,
    transactions,
    pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
    statusCounts: {
      UNMATCHED: statusCounts.UNMATCHED ?? 0,
      MATCHED:   statusCounts.MATCHED   ?? 0,
      // Show only non-pending ignored in the Ignorados tab counter
      IGNORED:   Math.max(0, (statusCounts.IGNORED ?? 0) - pendingCount),
      PENDING:   pendingCount,
      total:     (statusCounts.UNMATCHED ?? 0) + (statusCounts.MATCHED ?? 0) + (statusCounts.IGNORED ?? 0),
    },
  });
}

// DELETE /api/bancos/[id]
export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: bankAccountId } = await params;
  const account = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!account) return NextResponse.json({ error: "No encontrada" }, { status: 404 });

  const member = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: session.user.id, companyId: account.companyId } },
  });
  if (!member || member.role === "VIEWER") return NextResponse.json({ error: "Sin permisos" }, { status: 403 });

  await prisma.bankAccount.delete({ where: { id: bankAccountId } });
  return NextResponse.json({ ok: true });
}
