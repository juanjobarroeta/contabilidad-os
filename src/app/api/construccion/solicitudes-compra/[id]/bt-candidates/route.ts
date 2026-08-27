/**
 * GET /api/construccion/solicitudes-compra/[id]/bt-candidates
 *
 * Lists UNMATCHED outgoing BankTransactions that could plausibly fund this
 * APROBADA requisición. The "vincular" UI shows them so the user can pick
 * the SPEI that paid the OC instead of having the system create a synthetic
 * BT (which is what /pagar does — useful when the SPEI already exists in
 * the bancos table because the bank statement was imported first).
 *
 * Heuristics:
 *   - Same company, status UNMATCHED, monto < 0 (debit / outgoing)
 *   - |monto| within ±15% of OC.total
 *   - Date window: ±10 days around OC.createdAt
 *   - If OC has a supplier, prefer BTs whose supplierId matches OR
 *     whose descripcion contains a chunk of the supplier's razónSocial
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireMembership,
  requireModule,
  withAuthz,
} from "@/lib/authz";

const DELTA_PCT = 0.15;
const DATE_WINDOW_DAYS = 10;

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const sol = await prisma.solicitudCompra.findUnique({
      where: { id },
      select: {
        id: true,
        companyId: true,
        total: true,
        createdAt: true,
        supplierId: true,
        supplier: { select: { razonSocial: true } },
      },
    });
    if (!sol) throw new AuthzError(404, "Solicitud no encontrada");
    await requireMembership(sol.companyId, undefined, req);
    await requireModule(sol.companyId, "CONSTRUCCION");

    const minAmt = Number(sol.total) * (1 - DELTA_PCT);
    const maxAmt = Number(sol.total) * (1 + DELTA_PCT);
    const dateLow = new Date(sol.createdAt);
    dateLow.setDate(dateLow.getDate() - DATE_WINDOW_DAYS);
    const dateHigh = new Date(sol.createdAt);
    dateHigh.setDate(dateHigh.getDate() + DATE_WINDOW_DAYS);

    const candidates = await prisma.bankTransaction.findMany({
      where: {
        companyId: sol.companyId,
        status: "UNMATCHED",
        tipo: "DEBITO",
        // Negative-amount window: tx.monto is negative for debits, so
        // |tx.monto| ≈ sol.total ⇒ tx.monto between -maxAmt and -minAmt.
        monto: { gte: -maxAmt, lte: -minAmt },
        fecha: { gte: dateLow, lte: dateHigh },
      },
      select: {
        id: true,
        fecha: true,
        monto: true,
        descripcion: true,
        referencia: true,
        supplierId: true,
        bankAccount: { select: { banco: true, nombre: true } },
      },
      orderBy: { fecha: "desc" },
      take: 20,
    });

    // Score: same supplier wins; otherwise descripcion-substring against
    // razónSocial as a tiebreaker. Pure post-filter sort, no DB cost.
    const supplierName = sol.supplier?.razonSocial?.toLowerCase() ?? "";
    const scored = candidates
      .map((c) => {
        let score = 0;
        if (sol.supplierId && c.supplierId === sol.supplierId) score += 100;
        if (supplierName && c.descripcion?.toLowerCase().includes(supplierName.slice(0, 8))) {
          score += 20;
        }
        // Closer in amount = higher score
        const delta = Math.abs(Math.abs(Number(c.monto)) - Number(sol.total));
        score -= Math.round(delta);
        return { ...c, score };
      })
      .sort((a, b) => b.score - a.score);

    return NextResponse.json({ sol: { id: sol.id, total: sol.total }, candidates: scored });
  }
);
