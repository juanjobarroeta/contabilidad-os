/**
 * POST /api/construccion/adjudicaciones/:id/vincular-bt
 *
 * Link an existing (CSV-imported) BankTransaction to ONE supplier's payable,
 * instead of generating a synthetic one. Marks the adjudicación PAGADA and the
 * BankTransaction MATCHED; flips the parent requisición to PAGADA once every
 * supplier is settled. No ledger posting — the bank import owns that side.
 *
 * Body: { bankTransactionId }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter, withAuthz, AuthzError } from "@/lib/authz";
import { refreshSolicitudPagoEstado } from "@/lib/construccion/adjudicaciones";

const bodySchema = z.object({ bankTransactionId: z.string().min(1) });

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { bankTransactionId } = parsed.data;

    const adj = await prisma.solicitudAdjudicacion.findUnique({ where: { id } });
    if (!adj) throw new AuthzError(404, "Adjudicación no encontrada");

    await requireWriter(adj.companyId, req);
    await requireModule(adj.companyId, "CONSTRUCCION");

    if (adj.estado === "PAGADA" || adj.bankTransactionId) {
      return NextResponse.json({ error: "Esta adjudicación ya está pagada" }, { status: 409 });
    }

    const bt = await prisma.bankTransaction.findUnique({
      where: { id: bankTransactionId },
      select: { id: true, companyId: true, status: true, monto: true, fecha: true, supplierId: true },
    });
    if (!bt || bt.companyId !== adj.companyId) {
      return NextResponse.json({ error: "Movimiento bancario inválido" }, { status: 400 });
    }
    if (bt.status === "MATCHED") {
      return NextResponse.json({ error: "Ese movimiento ya está conciliado" }, { status: 409 });
    }
    // Loose amount guard (±15%) so an obviously-wrong link is rejected.
    if (Number(adj.total) > 0 && Math.abs(Math.abs(Number(bt.monto)) - Number(adj.total)) > Number(adj.total) * 0.15) {
      return NextResponse.json(
        { error: "El monto del movimiento no coincide con la adjudicación (±15%)" },
        { status: 422 }
      );
    }

    const fecha = bt.fecha ?? new Date();
    const result = await prisma.$transaction(async (tx) => {
      await tx.bankTransaction.update({
        where: { id: bt.id },
        data: {
          status: "MATCHED",
          ...(bt.supplierId ? {} : adj.supplierId ? { supplierId: adj.supplierId } : {}),
        },
      });
      const updated = await tx.solicitudAdjudicacion.update({
        where: { id: adj.id },
        data: { estado: "PAGADA", pagadaAt: fecha, bankTransactionId: bt.id },
      });
      await refreshSolicitudPagoEstado(tx, adj.solicitudId, fecha);
      return { adjudicacion: updated, bankTransactionId: bt.id };
    });

    return NextResponse.json(result);
  }
);
