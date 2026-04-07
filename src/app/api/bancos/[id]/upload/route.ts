import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseStatement } from "@/lib/bank-parser";

type Params = { params: Promise<{ id: string }> };

// POST /api/bancos/[id]/upload
// Body: { fileContent: string (text), filename: string }
export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: bankAccountId } = await params;

  const account = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!account) return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });

  const member = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: session.user.id, companyId: account.companyId } },
  });
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

    // Auto-tag bank fees + their IVA: the bank issues a single monthly CFDI
    // for all fees combined, so these can't be matched immediately. Park them
    // in IGNORED with a note so they leave "Sin conciliar"; user can move them
    // to MATCHED when the monthly CFDI arrives.
    const isBankFee = /comisi[oó]n|iva\s+comisi/i.test(tx.descripcion);
    const status = isBankFee ? "IGNORED" : "UNMATCHED";
    const notes = isBankFee ? "PENDING_MONTHLY_CFDI" : null;

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
