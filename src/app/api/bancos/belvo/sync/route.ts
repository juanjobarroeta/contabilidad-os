import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { listTransactions, listAccounts, isBelvoConfigured, type BelvoTransaction } from "@/lib/belvo";

// POST /api/bancos/belvo/sync
// Syncs transactions from Belvo for a bank account that has a belvoLinkId.
//
// Body: { bankAccountId, dateFrom?, dateTo? }
// Defaults: current month

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isBelvoConfigured()) {
    return NextResponse.json({ error: "Belvo no configurado" }, { status: 503 });
  }

  const body = await req.json();
  const { bankAccountId, dateFrom, dateTo } = body;

  if (!bankAccountId) {
    return NextResponse.json({ error: "bankAccountId requerido" }, { status: 400 });
  }

  const bankAccount = await prisma.bankAccount.findUnique({
    where: { id: bankAccountId },
    select: { id: true, companyId: true, belvoLinkId: true, belvoAccountId: true, nombre: true },
  });

  if (!bankAccount) return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });
  if (!bankAccount.belvoLinkId) {
    return NextResponse.json({ error: "Esta cuenta no tiene conexión Belvo. Conéctala primero." }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, bankAccount.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  // Default to current month
  const now = new Date();
  const from = dateFrom ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const to = dateTo ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${lastDay}`;

  try {
    // If we don't have a belvoAccountId yet, list accounts and pick the first checking account
    let belvoAccountId = bankAccount.belvoAccountId;
    if (!belvoAccountId) {
      const accounts = await listAccounts(bankAccount.belvoLinkId);
      const checking = accounts.find(a => a.type === "checking") ?? accounts[0];
      if (checking) {
        belvoAccountId = checking.id;
        await prisma.bankAccount.update({
          where: { id: bankAccountId },
          data: { belvoAccountId: checking.id },
        });
      }
    }

    const transactions = await listTransactions(
      bankAccount.belvoLinkId,
      from,
      to,
      belvoAccountId ?? undefined
    );

    // Upsert transactions — use belvoId as unique key to avoid duplicates
    let created = 0;
    let skipped = 0;

    for (const tx of transactions) {
      // Check if already imported (by belvoId or by matching date+amount+description)
      const existing = await prisma.bankTransaction.findFirst({
        where: {
          bankAccountId,
          OR: [
            { belvoId: tx.id },
            {
              fecha: new Date(tx.value_date || tx.accounting_date),
              monto: tx.amount,
              descripcion: tx.description.slice(0, 100),
            },
          ],
        },
        select: { id: true },
      });

      if (existing) { skipped++; continue; }

      await prisma.bankTransaction.create({
        data: {
          bankAccountId,
          companyId: bankAccount.companyId,
          fecha: new Date(tx.value_date || tx.accounting_date),
          descripcion: tx.description.replace(/\s+/g, " ").trim(),
          monto: tx.amount, // positive = credit, negative = debit
          saldo: tx.balance,
          referencia: tx.reference ?? undefined,
          belvoId: tx.id,
          belvoCategory: tx.category ?? undefined,
          source: "BELVO",
          tipo: tx.amount >= 0 ? "CREDITO" : "DEBITO",
        },
      });
      created++;
    }

    return NextResponse.json({
      ok: true,
      period: `${from} → ${to}`,
      fetched: transactions.length,
      created,
      skipped,
      bankAccount: bankAccount.nombre,
    });
  } catch (e) {
    console.error("[belvo/sync] Error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Error al sincronizar con Belvo" },
      { status: 502 }
    );
  }
}
