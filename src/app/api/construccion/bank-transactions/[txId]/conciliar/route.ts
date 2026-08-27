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
import { checkInvoiceMatchGuard, mergePagosConciliados } from "@/lib/conciliacion";
import { registrarBitacora } from "@/lib/audit";

const bodySchema = z.object({ invoiceId: z.string().min(1) });

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ txId: string }> }) => {
    const { txId } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const txRow = await prisma.bankTransaction.findUnique({
      where: { id: txId },
      select: { id: true, companyId: true, status: true, monto: true },
    });
    if (!txRow) throw new AuthzError(404, "Movimiento no encontrado");
    const tx = { ...txRow, monto: Number(txRow.monto) };
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
      select: {
        id: true,
        companyId: true,
        status: true,
        tipo: true,
        metodoPago: true,
        total: true,
        bankTransactions: {
          where: { status: "MATCHED" },
          select: { id: true, fecha: true, monto: true },
        },
        conciliacionDetalles: {
          select: {
            bankTransactionId: true,
            montoAsignado: true,
            bankTransaction: { select: { fecha: true, monto: true } },
          },
        },
      },
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

    // Guardia compartida (misma regla que el PATCH cookie-auth): una PUE ya
    // conciliada no admite un segundo movimiento; en PPD el acumulado de
    // parcialidades no puede exceder el total (tolerancia 1%). Los pagos
    // previos incluyen porciones asignadas (conciliación múltiple).
    const guard = checkInvoiceMatchGuard(
      { ...invoice, total: Number(invoice.total) },
      mergePagosConciliados(
        invoice.bankTransactions.map((b) => ({ ...b, monto: Number(b.monto) })),
        invoice.conciliacionDetalles.map((d) => ({
          ...d,
          montoAsignado: Number(d.montoAsignado),
          bankTransaction: { ...d.bankTransaction, monto: Number(d.bankTransaction.monto) },
        }))
      ),
      tx
    );
    if (!guard.ok) {
      return NextResponse.json({ error: guard.error }, { status: 409 });
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
    registrarBitacora({
      companyId: tx.companyId,
      accion: "conciliacion.match",
      entidad: "BankTransaction",
      entidadId: tx.id,
      detalle: { monto: tx.monto, invoiceId: invoice.id, via: "bearer-construccion" },
      req,
    });
    return NextResponse.json(updated);
  }
);
