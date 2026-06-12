import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getEffectiveCompanyMembership } from "@/lib/authz";

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

  const member = await getEffectiveCompanyMembership(session.user.id, account.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  // Tag-based subcategories of IGNORED that we surface as their own tabs.
  // Anything else with status=IGNORED falls into the plain "Ignorados" tab.
  const TAG_TABS: Record<string, string> = {
    PENDING:              "PENDING_MONTHLY_CFDI",
    TAX_PAYMENT:          "TAX_PAYMENT",
    PAYROLL_NO_CFDI:      "PAYROLL_NO_CFDI",
    LOAN_RECEIVED:        "LOAN_RECEIVED",
    LOAN_GIVEN:           "LOAN_GIVEN",
    CAPITAL_CONTRIBUTION: "CAPITAL_CONTRIBUTION",
    NON_DEDUCTIBLE:       "NON_DEDUCTIBLE",
    INTERNAL_TRANSFER:    "INTERNAL_TRANSFER",
  };
  const knownTags = Object.values(TAG_TABS);

  let where: Prisma.BankTransactionWhereInput = { bankAccountId };
  if (status && status in TAG_TABS) {
    where = { bankAccountId, status: "IGNORED", notes: TAG_TABS[status] };
  } else if (status === "IGNORED") {
    // Plain Ignorados = IGNORED rows whose notes is null or some other tag
    where = {
      bankAccountId,
      status: "IGNORED",
      OR: [{ notes: null }, { notes: { notIn: knownTags } }],
    };
  } else if (status && status !== "all") {
    // "all" (o sin status) = todos los movimientos, sin filtro de estado.
    // Cualquier otro valor es un estado del enum (UNMATCHED/MATCHED/IGNORED).
    where = { bankAccountId, status: status as "UNMATCHED" | "MATCHED" | "IGNORED" };
  }

  const [transactions, total] = await Promise.all([
    prisma.bankTransaction.findMany({
      where,
      include: {
        invoice: {
          select: { id: true, uuid: true, total: true, fecha: true, customer: { select: { razonSocial: true } } },
        },
        // Include construcción-side links so the bancos UI can show
        // "↳ Gasto / Reembolso / Raya" descriptors next to txs that
        // bartiz already linked.
        gastoPagado: {
          select: {
            id: true,
            beneficiarioNombre: true,
            importe: true,
            descripcion: true,
            proyecto: { select: { codigo: true } },
          },
        },
        reembolsoPagado: {
          select: {
            id: true,
            totalReembolso: true,
            semanaInicio: true,
            semanaFin: true,
            proyecto: { select: { codigo: true } },
          },
        },
        rayaPagada: {
          select: {
            id: true,
            totalDestajo: true,
            cuadrilla: { select: { nombre: true } },
            proyecto: { select: { codigo: true } },
          },
        },
      },
      orderBy: { fecha: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.bankTransaction.count({ where }),
  ]);

  // Status counts — group by status, then split IGNORED into its tagged subcategories
  const [counts, tagCounts] = await Promise.all([
    prisma.bankTransaction.groupBy({
      by: ["status"],
      where: { bankAccountId },
      _count: true,
    }),
    prisma.bankTransaction.groupBy({
      by: ["notes"],
      where: { bankAccountId, status: "IGNORED" },
      _count: true,
    }),
  ]);
  const statusCounts = Object.fromEntries(counts.map(c => [c.status, c._count]));
  const tagCountMap = Object.fromEntries(
    tagCounts.map(c => [c.notes ?? "__null__", c._count])
  );

  const subCounts = {
    PENDING:              tagCountMap["PENDING_MONTHLY_CFDI"] ?? 0,
    TAX_PAYMENT:          tagCountMap["TAX_PAYMENT"] ?? 0,
    PAYROLL_NO_CFDI:      tagCountMap["PAYROLL_NO_CFDI"] ?? 0,
    LOAN_RECEIVED:        tagCountMap["LOAN_RECEIVED"] ?? 0,
    LOAN_GIVEN:           tagCountMap["LOAN_GIVEN"] ?? 0,
    CAPITAL_CONTRIBUTION: tagCountMap["CAPITAL_CONTRIBUTION"] ?? 0,
    NON_DEDUCTIBLE:       tagCountMap["NON_DEDUCTIBLE"] ?? 0,
    INTERNAL_TRANSFER:    tagCountMap["INTERNAL_TRANSFER"] ?? 0,
  };
  const taggedTotal = Object.values(subCounts).reduce((s, n) => s + n, 0);

  return NextResponse.json({
    account,
    transactions,
    pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
    statusCounts: {
      UNMATCHED: statusCounts.UNMATCHED ?? 0,
      MATCHED:   statusCounts.MATCHED   ?? 0,
      // Plain Ignorados = total IGNORED minus tagged subcategories
      IGNORED:   Math.max(0, (statusCounts.IGNORED ?? 0) - taggedTotal),
      ...subCounts,
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

  const member = await getEffectiveCompanyMembership(session.user.id, account.companyId);
  if (!member || member.role === "VIEWER") return NextResponse.json({ error: "Sin permisos" }, { status: 403 });

  await prisma.bankAccount.delete({ where: { id: bankAccountId } });
  return NextResponse.json({ ok: true });
}
