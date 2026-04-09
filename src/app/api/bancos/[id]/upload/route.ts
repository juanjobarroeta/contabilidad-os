import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseStatement } from "@/lib/bank-parser";
import { getEffectiveCompanyMembership } from "@/lib/authz";

type Params = { params: Promise<{ id: string }> };

// POST /api/bancos/[id]/upload
// Body: { fileContent: string (text), filename: string }
export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: bankAccountId } = await params;

  const account = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!account) return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, account.companyId);
  if (!member || member.role === "VIEWER") return NextResponse.json({ error: "Sin permisos" }, { status: 403 });

  const body = await req.json();
  const { fileContent, filename } = body as { fileContent: string; filename: string };

  if (!fileContent) return NextResponse.json({ error: "Archivo vacío" }, { status: 400 });

  // Parse the statement
  const parseResult = parseStatement(fileContent, filename ?? "statement.csv");

  if (parseResult.transactions.length === 0) {
    return NextResponse.json({
      error: "No se encontraron transacciones en el archivo.",
      warnings: parseResult.warnings,
    }, { status: 422 });
  }

  // Deduplicate against existing transactions
  // Check by: bankAccountId + fecha + monto + first 80 chars of descripcion
  let imported = 0;
  let skipped  = 0;

  for (const tx of parseResult.transactions) {
    const fechaStart = new Date(tx.fecha);
    fechaStart.setHours(0, 0, 0, 0);
    const fechaEnd = new Date(tx.fecha);
    fechaEnd.setHours(23, 59, 59, 999);

    const exists = await prisma.bankTransaction.findFirst({
      where: {
        bankAccountId,
        fecha: { gte: fechaStart, lte: fechaEnd },
        monto: tx.monto,
        descripcion: tx.descripcion,
        referencia: tx.referencia ?? null,
      },
    });

    if (exists) { skipped++; continue; }

    // Auto-categorize on import. We use IGNORED + a notes tag for items that
    // can't or shouldn't be matched against a customer/supplier CFDI:
    //   - PENDING_MONTHLY_CFDI: bank fees (consolidated CFDI arrives later)
    //   - TAX_PAYMENT: payments to SAT (no CFDI ever exists)
    //   - INTERNAL_TRANSFER: between own accounts (no P&L impact)
    // Everything else stays UNMATCHED for the user to resolve manually.
    const desc = tx.descripcion;
    const isBankFee = /comisi[oó]n|iva\s+comisi/i.test(desc);
    const isTaxPayment = /pago\s+de\s+impuestos|^impuesto|recaudaci[oó]n|sat\s|tesofe/i.test(desc);
    const isInternalTransfer = /traspaso\s+(entre|a)\s+cuentas?\s+propias?|transferencia\s+propia/i.test(desc);

    let status: "UNMATCHED" | "IGNORED" = "UNMATCHED";
    let notes: string | null = null;
    if (isBankFee) {
      status = "IGNORED";
      notes = "PENDING_MONTHLY_CFDI";
    } else if (isTaxPayment) {
      status = "IGNORED";
      notes = "TAX_PAYMENT";
    } else if (isInternalTransfer) {
      status = "IGNORED";
      notes = "INTERNAL_TRANSFER";
    }

    await prisma.bankTransaction.create({
      data: {
        companyId:    account.companyId,
        bankAccountId,
        fecha:        tx.fecha,
        descripcion:  tx.descripcion,
        monto:        tx.monto,
        saldo:        tx.saldo ?? null,
        referencia:   tx.referencia ?? null,
        tipo:         tx.monto >= 0 ? "CREDITO" : "DEBITO",
        status,
        notes,
        source:       "UPLOAD",
      },
    });
    imported++;
  }

  return NextResponse.json({
    ok: true,
    imported,
    skipped,
    format:       parseResult.format,
    detectedBank: parseResult.detectedBank,
    warnings:     parseResult.warnings,
    message:      `${imported} movimiento(s) importados${skipped > 0 ? `, ${skipped} ya existían` : ""}.`,
  });
}
