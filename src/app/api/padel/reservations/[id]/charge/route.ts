/**
 * POST /api/padel/reservations/[id]/charge
 *
 * The PADEL money loop — collects payment for a court reservation and posts it
 * to the general ledger atomically. This is the proof-flow that exercises
 * schema + auth + module gate + postings in one request.
 *
 * Body: {
 *   formaPago: "EFECTIVO" | "TRANSFERENCIA" | "TARJETA" | "CORTESIA" | "CUENTA",
 *   bankAccountId?: string,   // required for TRANSFERENCIA / TARJETA
 *   precio?: number,          // override the reservation price at charge time
 *   fecha?: string            // ISO; defaults to now
 * }
 *
 * Atomic flow (TRANSFERENCIA/TARJETA shown; cash/cuenta skip the BankTransaction):
 *   1. (bank only) create BankTransaction (CREDITO, +total con IVA, MATCHED)
 *   2. post balanced ledger rows via postCourtRentalRevenue (DR cash/bank/CxC,
 *      CR 4150 ingresos, CR 2102 IVA)
 *   3. mark the reservation pagado + link the BankTransaction
 *
 * CORTESIA (comp) posts nothing — it just records that the slot was gifted.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { postCourtRentalRevenue } from "@/lib/accounting/postings";
import { splitIvaIncluded, slotLabel } from "@/lib/padel";

const chargeSchema = z.object({
  formaPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "TARJETA", "CORTESIA", "CUENTA"]),
  bankAccountId: z.string().optional(),
  precio: z.number().nonnegative().optional(),
  fecha: z.string().datetime().optional(),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = chargeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { formaPago, bankAccountId } = parsed.data;
    const fecha = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date();

    const reservation = await prisma.reservation.findUnique({
      where: { id },
      include: { court: { select: { nombre: true } } },
    });
    if (!reservation) throw new AuthzError(404, "Reserva no encontrada");

    await requireWriter(reservation.companyId, req);
    await requireModule(reservation.companyId, "PADEL", req);

    if (reservation.pagado) {
      return NextResponse.json({ error: "La reserva ya fue cobrada" }, { status: 409 });
    }
    if (reservation.estado === "CANCELADA") {
      return NextResponse.json(
        { error: "No se puede cobrar una reserva cancelada" },
        { status: 422 }
      );
    }

    const total = parsed.data.precio ?? reservation.precio;

    // CORTESIA: gift the slot, no money, no ledger.
    if (formaPago === "CORTESIA") {
      const updated = await prisma.reservation.update({
        where: { id },
        data: { pagado: true, formaPago: "CORTESIA", cobradoAt: fecha, precio: total },
      });
      return NextResponse.json({ reservation: updated, bankTransactionId: null });
    }

    if (!(total > 0)) {
      return NextResponse.json(
        { error: "El precio de la reserva debe ser mayor a 0 para cobrar" },
        { status: 422 }
      );
    }

    const isBank = formaPago === "TRANSFERENCIA" || formaPago === "TARJETA";
    let bankAccount: { id: string; companyId: string } | null = null;
    if (isBank) {
      if (!bankAccountId) {
        return NextResponse.json(
          { error: "bankAccountId requerido para pago con transferencia/tarjeta" },
          { status: 400 }
        );
      }
      bankAccount = await prisma.bankAccount.findUnique({
        where: { id: bankAccountId },
        select: { id: true, companyId: true },
      });
      if (!bankAccount || bankAccount.companyId !== reservation.companyId) {
        return NextResponse.json({ error: "Cuenta bancaria inválida" }, { status: 400 });
      }
    }

    // Resolve the club's IVA rate (default 0.16) and back out IVA from the total.
    const config = await prisma.padelClubConfig.findUnique({
      where: { companyId: reservation.companyId },
      select: { ivaRate: true },
    });
    const ivaRate = config?.ivaRate ?? 0.16;
    const { subtotal, iva } = splitIvaIncluded(total, ivaRate);
    const descripcion = slotLabel(reservation.court.nombre, reservation.inicio);

    const result = await prisma.$transaction(async (tx) => {
      let bankTxId: string | null = null;

      if (isBank && bankAccount) {
        const bankTx = await tx.bankTransaction.create({
          data: {
            companyId: reservation.companyId,
            bankAccountId: bankAccount.id,
            fecha,
            descripcion,
            referencia: id,
            monto: Math.abs(total), // positive = credit (money in)
            tipo: "CREDITO",
            status: "MATCHED",
            source: "PADEL",
            notes: `Generado por padel: reserva ${id}`,
          },
        });
        bankTxId = bankTx.id;
      }

      await postCourtRentalRevenue(tx, {
        companyId: reservation.companyId,
        reservationId: id,
        descripcion,
        subtotal,
        iva,
        formaPago: formaPago as "EFECTIVO" | "TRANSFERENCIA" | "TARJETA" | "CUENTA",
        fecha,
      });

      const updated = await tx.reservation.update({
        where: { id },
        data: {
          pagado: true,
          formaPago,
          cobradoAt: fecha,
          precio: total,
          bankTransactionId: bankTxId,
        },
      });

      return { reservation: updated, bankTransactionId: bankTxId };
    });

    return NextResponse.json(result);
  }
);
