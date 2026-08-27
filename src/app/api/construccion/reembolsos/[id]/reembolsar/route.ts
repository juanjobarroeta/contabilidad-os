/**
 * POST /api/construccion/reembolsos/[id]/reembolsar
 *
 * One-click atomic close: Katia has reviewed every line, total is right,
 * Juan SPEIs Rosy. The endpoint:
 *   1. Validates every gasto in the package has attribution (directo OR
 *      indirecto with categoría). Refuses otherwise — consistency with
 *      individual aprobar-pagar.
 *   2. Validates the reembolso is in SUBMITTED or REVISADO state.
 *   3. Creates ONE BankTransaction DEBITO for totalReembolso from the
 *      reembolso's bankAccountId. Description references the proyecto +
 *      week + Rosy.
 *   4. Flips every non-PAGADO Gasto in the package to PAGADO, sets their
 *      bankTransactionId = the single BT, stamps pagadoAt. This means
 *      the weekly package resolves cleanly: one outgoing SPEI, many
 *      gastos settled.
 *   5. Flips reembolso.estado = REEMBOLSADO + sets bankTransactionId +
 *      reembolsadoAt + reembolsadoPor.
 *
 * Body (all optional):
 *   { fecha?: ISO, referencia?: string, pagoComprobanteUrl?: string }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireModule,
  requireUser,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

const bodySchema = z.object({
  // Three close modes:
  //   A) bankTransactionId — link to an existing CSV-imported tx
  //   B) fecha + referencia — create a fresh BT (manual fallback)
  //   C) offBooks=true — close the período WITHOUT creating a BT.
  //      Used when the reimbursement is handled outside the system
  //      (cash, off-books transfer, etc.). Bartiz uses this today.
  bankTransactionId: z.string().min(1).optional(),
  fecha: z.string().optional(),
  referencia: z.string().max(80).nullable().optional(),
  pagoComprobanteUrl: z.string().max(1000).nullable().optional(),
  offBooks: z.boolean().optional(),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const reembolso = await prisma.reembolsoSemanal.findUnique({
      where: { id },
      include: {
        proyecto: { select: { codigo: true, nombre: true } },
        bankAccount: { select: { id: true, nombre: true } },
        gastos: {
          select: {
            id: true,
            importe: true,
            estado: true,
            presupuestoPartidaId: true,
            insumoId: true,
            indirecto: true,
            categoriaIndirecto: true,
            bankTransactionId: true,
          },
        },
      },
    });
    if (!reembolso) throw new AuthzError(404, "Reembolso no encontrado");
    await requireWriter(reembolso.companyId, req);
    await requireModule(reembolso.companyId, "CONSTRUCCION");

    if (reembolso.estado === "REEMBOLSADO") {
      return NextResponse.json(
        { error: "El reembolso ya fue pagado" },
        { status: 409 }
      );
    }
    if (reembolso.estado === "RECHAZADO") {
      return NextResponse.json(
        { error: "El reembolso está rechazado; no se puede pagar" },
        { status: 422 }
      );
    }

    if (reembolso.gastos.length === 0) {
      return NextResponse.json(
        { error: "El reembolso no tiene gastos" },
        { status: 422 }
      );
    }

    // Validate every gasto has attribution
    const sinAtribucion = reembolso.gastos.filter(
      (g) =>
        !g.presupuestoPartidaId &&
        !g.insumoId &&
        !(g.indirecto === true && g.categoriaIndirecto)
    );
    if (sinAtribucion.length > 0) {
      return NextResponse.json(
        {
          error: `Hay ${sinAtribucion.length} gasto(s) sin atribución. Vincúlalos antes de reembolsar.`,
          gastosSinAtribucion: sinAtribucion.map((g) => g.id),
        },
        { status: 422 }
      );
    }

    const user = await requireUser(req).catch(() => null);
    const totalReembolso = Number(reembolso.totalReembolso);

    if (totalReembolso <= 0) {
      return NextResponse.json(
        { error: `totalReembolso es ${totalReembolso}; no hay nada que pagar` },
        { status: 422 }
      );
    }

    const desc = `Reembolso semanal a Rosy — ${reembolso.proyecto.codigo} · ${reembolso.semanaInicio.toISOString().slice(0, 10)} al ${reembolso.semanaFin.toISOString().slice(0, 10)}`;

    const result = await prisma.$transaction(async (tx) => {
      const fresh = await tx.reembolsoSemanal.findUnique({
        where: { id },
        select: { estado: true, bankTransactionId: true },
      });
      if (fresh?.estado === "REEMBOLSADO" || fresh?.bankTransactionId) {
        throw new AuthzError(409, "El reembolso ya fue pagado");
      }

      let bankTx: { id: string } | null = null;
      if (parsed.data.offBooks) {
        // Off-books close: don't create or link any BankTransaction.
        // The reimbursement to the responsable is handled outside the
        // system. Gastos still flip to PAGADO so they don't keep
        // showing as pending, but their bankTransactionId stays null.
      } else if (parsed.data.bankTransactionId) {
        const existing = await tx.bankTransaction.findUnique({
          where: { id: parsed.data.bankTransactionId },
          select: {
            id: true,
            companyId: true,
            monto: true,
            gastoPagado: { select: { id: true } },
            rayaPagada: { select: { id: true } },
            reembolsoPagado: { select: { id: true } },
          },
        });
        if (!existing || existing.companyId !== reembolso.companyId) {
          throw new AuthzError(400, "BankTransaction inválido");
        }
        if (existing.gastoPagado || existing.rayaPagada || existing.reembolsoPagado) {
          throw new AuthzError(409, "Esa transacción bancaria ya está vinculada a otro pago");
        }
        bankTx = await tx.bankTransaction.update({
          where: { id: existing.id },
          data: { status: "MATCHED" },
        });
      } else {
        // Manual fallback. Same rationale as aprobar-pagar — preferred
        // is to import the CSV and pick the real bank tx.
        bankTx = await tx.bankTransaction.create({
        data: {
          companyId: reembolso.companyId,
          bankAccountId: reembolso.bankAccountId,
          fecha: parsed.data.fecha ? new Date(parsed.data.fecha) : new Date(),
          descripcion: desc,
          referencia: parsed.data.referencia ?? null,
          monto: -Math.abs(totalReembolso),
          tipo: "DEBITO",
          status: "MATCHED",
          source: "MANUAL",
        },
        });
      }

      // Flip every gasto to PAGADO. Link to the BT if one was created
      // or matched; null otherwise (off-books mode).
      for (const g of reembolso.gastos) {
        if (g.estado === "PAGADO") continue;
        await tx.gasto.update({
          where: { id: g.id },
          data: {
            estado: "PAGADO",
            bankTransactionId: bankTx?.id ?? null,
            pagadoAt: new Date(),
            aprobadoPor: user?.id ?? null,
            aprobadoAt: new Date(),
            pagoComprobanteUrl: parsed.data.pagoComprobanteUrl ?? undefined,
          },
        });
      }

      const updated = await tx.reembolsoSemanal.update({
        where: { id },
        data: {
          estado: "REEMBOLSADO",
          bankTransactionId: bankTx?.id ?? null,
          reembolsadoAt: new Date(),
          reembolsadoPor: user?.id ?? null,
        },
        include: {
          bankTransaction: true,
          gastos: true,
        },
      });

      return updated;
    });

    return NextResponse.json(result);
  }
);
