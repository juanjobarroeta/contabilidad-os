/**
 * GET /api/construccion/bank-transactions/[txId]/cfdi-candidatos
 *
 * Candidatos CFDI para conciliar UN movimiento bancario importado, rankeados
 * con el MISMO scoring del auto-conciliador fiscal (monto/fecha/RFC). Espejo
 * bearer del GET /api/bancos/[id]/match (cookie-auth) para que bartiz pueda
 * conciliar desde "Bancos y conciliación".
 *
 * Dirección: CREDITO (entra dinero) → INGRESO; DEBITO (sale) → EGRESO.
 * Ventana manual, más amplia que la del auto: ±30 días, ±5% de monto.
 * Facturas ya MATCHED a otro movimiento se excluyen, salvo PPD (pagos
 * parciales múltiples).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { scoreCandidate } from "@/lib/bancos/auto-conciliar";

const WINDOW_DAYS = 30;
const TOLERANCE = 0.05;

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ txId: string }> }) => {
    const { txId } = await ctx.params;

    const tx = await prisma.bankTransaction.findUnique({
      where: { id: txId },
      select: {
        id: true,
        companyId: true,
        fecha: true,
        descripcion: true,
        monto: true,
        status: true,
        invoiceId: true,
      },
    });
    if (!tx) throw new AuthzError(404, "Movimiento no encontrado");
    await requireMembership(tx.companyId, undefined, req);
    await requireModule(tx.companyId, "CONSTRUCCION");

    const monto = Number(tx.monto);
    const absAmount = Math.abs(monto);
    const invoiceType = monto > 0 ? "INGRESO" : "EGRESO";
    const windowStart = new Date(tx.fecha.getTime() - WINDOW_DAYS * 86400000);
    const windowEnd = new Date(tx.fecha.getTime() + WINDOW_DAYS * 86400000);

    const invoices = await prisma.invoice.findMany({
      where: {
        companyId: tx.companyId,
        tipo: invoiceType,
        status: "STAMPED",
        fecha: { gte: windowStart, lte: windowEnd },
        total: { gte: absAmount * (1 - TOLERANCE), lte: absAmount * (1 + TOLERANCE) },
        // Ya conciliadas a otro movimiento quedan fuera — por el vínculo legado
        // 1:1 o por porciones asignadas (ConciliacionDetalle) — salvo PPD, que
        // puede pagarse con varios movimientos parciales.
        OR: [
          {
            bankTransactions: { none: { status: "MATCHED" } },
            conciliacionDetalles: { none: {} },
          },
          { metodoPago: "PPD" },
        ],
      },
      select: {
        id: true,
        uuid: true,
        serie: true,
        folio: true,
        fecha: true,
        total: true,
        metodoPago: true,
        formaPago: true,
        customer: { select: { rfc: true, razonSocial: true } },
        bankTransactions: {
          where: { status: "MATCHED" },
          select: { id: true, monto: true },
        },
        conciliacionDetalles: { select: { montoAsignado: true } },
      },
      take: 100,
    });

    const candidates = invoices
      .map((inv) => {
        const total = Number(inv.total);
        const matchedAmount =
          inv.bankTransactions.reduce((s, b) => s + Math.abs(Number(b.monto)), 0) +
          inv.conciliacionDetalles.reduce((s, d) => s + Math.abs(Number(d.montoAsignado)), 0);
        return {
          id: inv.id,
          uuid: inv.uuid,
          serie: inv.serie,
          folio: inv.folio,
          fecha: inv.fecha,
          total,
          metodoPago: inv.metodoPago,
          formaPago: inv.formaPago,
          rfc: inv.customer?.rfc ?? null,
          nombre: inv.customer?.razonSocial ?? null,
          alreadyMatched: inv.bankTransactions.length > 0 || inv.conciliacionDetalles.length > 0,
          matchedAmount,
          remainingBalance: Math.max(0, total - matchedAmount),
          score: scoreCandidate(
            { total, fecha: inv.fecha, customerRfc: inv.customer?.rfc ?? null },
            { fecha: tx.fecha, descripcion: tx.descripcion },
            absAmount
          ),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    return NextResponse.json({
      transaction: {
        id: tx.id,
        fecha: tx.fecha,
        descripcion: tx.descripcion,
        monto: tx.monto,
        status: tx.status,
        invoiceId: tx.invoiceId,
      },
      candidates,
    });
  }
);
