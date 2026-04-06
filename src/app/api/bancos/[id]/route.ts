import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };

// GET /api/bancos/[id]?status=UNMATCHED&page=1&pageSize=50
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

  const where = {
    bankAccountId,
    ...(status ? { status: status as "UNMATCHED" | "MATCHED" | "IGNORED" } : {}),
  };

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

  // Status counts
  const counts = await prisma.bankTransaction.groupBy({
    by: ["status"],
    where: { bankAccountId },
    _count: true,
  });
  const statusCounts = Object.fromEntries(counts.map(c => [c.status, c._count]));

  return NextResponse.json({
    account,
    transactions,
    pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
    statusCounts: {
      UNMATCHED: statusCounts.UNMATCHED ?? 0,
      MATCHED:   statusCounts.MATCHED   ?? 0,
      IGNORED:   statusCounts.IGNORED   ?? 0,
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
