/**
 * POST /api/construccion/adjudicaciones/:id/pagar
 *
 * Pay ONE supplier's slice of a requisición. Mirrors the requisición-level
 * /pagar but scoped to a single adjudicación:
 *   POR_PAGAR adjudicación → BankTransaction (DEBITO) + ledger pair (5101/1101)
 *   ─────────────────────────────────────────────────────────────────────────
 *     • adjudicación.estado → PAGADA, bankTransactionId set
 *     • parent solicitud flips to PAGADA only once every supplier is paid
 *
 * Body: { bankAccountId, fecha?, referencia? }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter, withAuthz, AuthzError } from "@/lib/authz";
import { postSolicitudCompraPaid } from "@/lib/accounting/postings";
import { refreshSolicitudPagoEstado } from "@/lib/construccion/adjudicaciones";

const pagarSchema = z.object({
  bankAccountId: z.string().min(1),
  fecha: z.string().datetime().optional(),
  referencia: z.string().optional(),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const body = await req.json().catch(() => ({}));
    const parsed = pagarSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { bankAccountId, referencia } = parsed.data;
    const fecha = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date();

    const adj = await prisma.solicitudAdjudicacion.findUnique({
      where: { id },
      include: {
        solicitud: { select: { id: true, folio: true, proyecto: { select: { codigo: true } } } },
      },
    });
    if (!adj) throw new AuthzError(404, "Adjudicación no encontrada");

    await requireWriter(adj.companyId, req);
    await requireModule(adj.companyId, "CONSTRUCCION");

    if (adj.estado === "PAGADA" || adj.bankTransactionId) {
      return NextResponse.json(
        { error: "Esta adjudicación ya está pagada" },
        { status: 409 }
      );
    }

    const bankAccount = await prisma.bankAccount.findUnique({
      where: { id: bankAccountId },
      select: { id: true, companyId: true },
    });
    if (!bankAccount || bankAccount.companyId !== adj.companyId) {
      return NextResponse.json({ error: "Cuenta bancaria inválida" }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx) => {
      const bankTx = await tx.bankTransaction.create({
        data: {
          companyId: adj.companyId,
          bankAccountId: bankAccount.id,
          fecha,
          descripcion: `Pago ${adj.supplierNombre} — solicitud ${adj.solicitud.folio}`,
          referencia: referencia ?? adj.solicitud.folio,
          monto: -Math.abs(adj.total),
          tipo: "DEBITO",
          status: "MATCHED",
          supplierId: adj.supplierId ?? undefined,
          source: "UPLOAD",
          notes: `Generado por construccion: adjudicación ${adj.id}`,
        },
      });

      await postSolicitudCompraPaid(tx, {
        companyId: adj.companyId,
        solicitudId: adj.solicitudId,
        folio: `${adj.solicitud.folio} · ${adj.supplierNombre}`,
        monto: adj.total,
        fecha,
        proyectoCodigo: adj.solicitud.proyecto?.codigo,
      });

      const updated = await tx.solicitudAdjudicacion.update({
        where: { id: adj.id },
        data: { estado: "PAGADA", pagadaAt: fecha, bankTransactionId: bankTx.id },
      });

      // Flip the parent requisición to PAGADA once all suppliers are paid.
      await refreshSolicitudPagoEstado(tx, adj.solicitudId, fecha);

      return { adjudicacion: updated, bankTransactionId: bankTx.id };
    });

    return NextResponse.json(result);
  }
);
