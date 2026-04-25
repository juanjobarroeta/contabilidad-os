/**
 * POST /api/construccion/rayas/[id]/pagar
 *
 * APROBADA → PAGADA. Creates a BankTransaction debitada from the given
 * bankAccountId (typically one of the tarjetas departamentales) for
 * the raya's totalDestajo. Atomic — if the bank tx fails, raya stays
 * APROBADA.
 *
 * Body: {
 *   bankAccountId: string   // which account paid
 *   fecha: ISO date          // when the cash left the account
 *   referencia?: string       // cheque #, transfer id, etc.
 * }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

const schema = z.object({
  bankAccountId: z.string().min(1),
  fecha: z.string(),
  referencia: z.string().max(80).nullable().optional(),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const raya = await prisma.rayaSemanal.findUnique({
      where: { id },
      include: {
        cuadrilla: { select: { nombre: true, especialidad: true } },
        proyecto: { select: { codigo: true, nombre: true } },
      },
    });
    if (!raya) throw new AuthzError(404, "Raya no encontrada");
    await requireWriter(raya.companyId, req);
    await requireModule(raya.companyId, "CONSTRUCCION_CUADRILLAS");

    if (raya.estado !== "APROBADA") {
      return NextResponse.json(
        { error: `Transición inválida: ${raya.estado} → PAGADA (aprueba primero)` },
        { status: 422 }
      );
    }

    // Validate the bank account belongs to the same company
    const account = await prisma.bankAccount.findUnique({
      where: { id: parsed.data.bankAccountId },
      select: { id: true, companyId: true, nombre: true },
    });
    if (!account || account.companyId !== raya.companyId) {
      return NextResponse.json({ error: "BankAccount inválido" }, { status: 400 });
    }

    const desc = `Raya semanal ${raya.cuadrilla.nombre} — ${raya.proyecto.codigo}`;

    const result = await prisma.$transaction(async (tx) => {
      // Idempotent guard — if another tab already paid this raya, bail.
      const fresh = await tx.rayaSemanal.findUnique({
        where: { id },
        select: { estado: true, bankTransactionId: true },
      });
      if (fresh?.estado === "PAGADA" || fresh?.bankTransactionId) {
        throw new AuthzError(409, "La raya ya fue pagada");
      }

      const bankTx = await tx.bankTransaction.create({
        data: {
          companyId: raya.companyId,
          bankAccountId: account.id,
          fecha: new Date(parsed.data.fecha),
          descripcion: desc,
          referencia: parsed.data.referencia ?? null,
          monto: -Math.abs(raya.totalDestajo),
          tipo: "DEBITO",
          status: "MATCHED",
          // Manual fallback when no existing CSV-imported tx is picked.
          source: "MANUAL",
        },
      });

      const updated = await tx.rayaSemanal.update({
        where: { id },
        data: {
          estado: "PAGADA",
          bankTransactionId: bankTx.id,
          pagadaAt: new Date(),
        },
        include: { cuadrilla: true, bankTransaction: true },
      });

      return updated;
    });

    return NextResponse.json(result);
  }
);
