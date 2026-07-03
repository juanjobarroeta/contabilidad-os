/**
 * POST /api/construccion/bank-transactions/[txId]/desconciliar
 *
 * Deshace un empate movimiento ↔ CFDI (status → UNMATCHED, invoiceId → null).
 * Sólo aplica a matches de CFDI; si el movimiento está vinculado a una entidad
 * de construcción (gasto/raya/reembolso/estimación) se rechaza — eso se
 * desvincula desde la entidad para no dejarla marcada como pagada con un
 * movimiento fantasma.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ txId: string }> }) => {
    const { txId } = await ctx.params;

    const tx = await prisma.bankTransaction.findUnique({
      where: { id: txId },
      select: {
        id: true,
        companyId: true,
        status: true,
        invoiceId: true,
        gastoPagado: { select: { id: true } },
        rayaPagada: { select: { id: true } },
        reembolsoPagado: { select: { id: true } },
        solicitudCompraPagada: { select: { id: true } },
        adjudicacionPagada: { select: { id: true } },
        estimacionCobrada: { select: { id: true } },
      },
    });
    if (!tx) throw new AuthzError(404, "Movimiento no encontrado");
    await requireWriter(tx.companyId, req);
    await requireModule(tx.companyId, "CONSTRUCCION");

    if (tx.status !== "MATCHED") {
      return NextResponse.json({ error: "Este movimiento no está conciliado" }, { status: 409 });
    }
    const entityLinked =
      tx.gastoPagado || tx.rayaPagada || tx.reembolsoPagado ||
      tx.solicitudCompraPagada || tx.adjudicacionPagada || tx.estimacionCobrada;
    if (entityLinked && !tx.invoiceId) {
      return NextResponse.json(
        { error: "Este movimiento está vinculado a un pago de construcción; desvincúlalo desde esa entidad." },
        { status: 422 }
      );
    }

    const updated = await prisma.bankTransaction.update({
      where: { id: tx.id },
      data: { status: "UNMATCHED", invoiceId: null },
      select: { id: true, status: true, invoiceId: true },
    });
    registrarBitacora({
      companyId: tx.companyId,
      accion: "conciliacion.unmatch",
      entidad: "BankTransaction",
      entidadId: tx.id,
      detalle: { invoiceId: tx.invoiceId, via: "bearer-construccion" },
      req,
    });
    return NextResponse.json(updated);
  }
);
