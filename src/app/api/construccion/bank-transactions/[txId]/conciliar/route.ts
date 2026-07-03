/**
 * POST /api/construccion/bank-transactions/[txId]/conciliar
 *
 * Confirma el empate movimiento bancario ↔ CFDI: la conciliación real
 * (BankTransaction.status = MATCHED + invoiceId), misma escritura que el
 * PATCH cookie-auth de /api/bancos/transactions/[txId] action:"match".
 * Espejo bearer para bartiz.
 *
 * Body: { invoiceId }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const bodySchema = z.object({ invoiceId: z.string().min(1) });

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ txId: string }> }) => {
    const { txId } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const tx = await prisma.bankTransaction.findUnique({
      where: { id: txId },
      select: { id: true, companyId: true, status: true, monto: true },
    });
    if (!tx) throw new AuthzError(404, "Movimiento no encontrado");
    await requireWriter(tx.companyId, req);
    await requireModule(tx.companyId, "CONSTRUCCION");

    if (tx.status === "MATCHED") {
      return NextResponse.json(
        { error: "Este movimiento ya está conciliado. Desconcílialo primero." },
        { status: 409 }
      );
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: parsed.data.invoiceId },
      select: { id: true, companyId: true, status: true, tipo: true },
    });
    if (!invoice || invoice.companyId !== tx.companyId) {
      return NextResponse.json({ error: "CFDI inválido" }, { status: 400 });
    }
    if (invoice.status !== "STAMPED") {
      return NextResponse.json(
        { error: "Solo se pueden conciliar CFDIs timbrados" },
        { status: 422 }
      );
    }
    // Coherencia de dirección: dinero que sale ↔ EGRESO; que entra ↔ INGRESO.
    const expected = tx.monto > 0 ? "INGRESO" : "EGRESO";
    if (invoice.tipo !== expected) {
      return NextResponse.json(
        { error: `Dirección incompatible: este movimiento corresponde a un CFDI ${expected}` },
        { status: 422 }
      );
    }

    const updated = await prisma.bankTransaction.update({
      where: { id: tx.id },
      data: { status: "MATCHED", invoiceId: invoice.id },
      select: {
        id: true,
        status: true,
        invoiceId: true,
        invoice: { select: { id: true, uuid: true, serie: true, folio: true, total: true } },
      },
    });
    return NextResponse.json(updated);
  }
);
