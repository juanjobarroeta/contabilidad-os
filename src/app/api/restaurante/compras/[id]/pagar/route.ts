/**
 * POST /api/restaurante/compras/[id]/pagar
 *
 * Settles the payable created at receipt. Atomic flow (bank forms shown;
 * EFECTIVO skips the BankTransaction):
 *   1. (TRANSFERENCIA/TARJETA) create BankTransaction (DEBITO, -total, MATCHED)
 *   2. post DR 2104 Acreedores / CR 1100 Caja | 1101 Bancos
 *   3. estado → PAGADA
 *
 * Body: { formaPago: "EFECTIVO"|"TRANSFERENCIA"|"TARJETA",
 *         bankAccountId?, fecha? }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { postCompraRestaurantePagada } from "@/lib/accounting/postings";

const bodySchema = z.object({
  formaPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "TARJETA"]),
  bankAccountId: z.string().optional(),
  fecha: z.string().datetime().optional(),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { formaPago, bankAccountId } = parsed.data;
    const fecha = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date();

    const compra = await prisma.restCompra.findUnique({
      where: { id },
      include: { supplier: { select: { id: true, razonSocial: true } } },
    });
    if (!compra) throw new AuthzError(404, "Compra no encontrada");

    await requireWriter(compra.companyId, req);
    await requireModule(compra.companyId, "RESTAURANTE", req);

    if (compra.estado !== "RECIBIDA") {
      return NextResponse.json(
        { error: `Sólo se pueden pagar compras RECIBIDAS (estado actual: ${compra.estado})` },
        { status: 422 }
      );
    }

    const total = Math.round((compra.subtotal + compra.iva) * 100) / 100;
    if (!(total > 0)) {
      return NextResponse.json({ error: "El total de la compra debe ser mayor a 0" }, { status: 422 });
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
      if (!bankAccount || bankAccount.companyId !== compra.companyId) {
        return NextResponse.json({ error: "Cuenta bancaria inválida" }, { status: 400 });
      }
    }

    const descripcion =
      `Pago compra insumos ${compra.folio}` +
      (compra.supplier ? ` — ${compra.supplier.razonSocial}` : "");

    const result = await prisma.$transaction(async (tx) => {
      let bankTxId: string | null = null;

      if (isBank && bankAccount) {
        const bankTx = await tx.bankTransaction.create({
          data: {
            companyId: compra.companyId,
            bankAccountId: bankAccount.id,
            fecha,
            descripcion,
            referencia: compra.folio,
            monto: -Math.abs(total), // negative = debit (money out)
            tipo: "DEBITO",
            status: "MATCHED",
            source: "RESTAURANTE",
            supplierId: compra.supplierId,
            notes: `Generado por restauranteos: compra ${compra.id}`,
          },
        });
        bankTxId = bankTx.id;
      }

      await postCompraRestaurantePagada(tx, {
        companyId: compra.companyId,
        compraId: compra.id,
        folio: compra.folio,
        total,
        formaPago,
        fecha,
        proveedorNombre: compra.supplier?.razonSocial,
      });

      const updated = await tx.restCompra.update({
        where: { id },
        data: {
          estado: "PAGADA",
          pagadaAt: fecha,
          formaPago,
          bankAccountId: bankAccount?.id ?? null,
          bankTransactionId: bankTxId,
        },
        include: {
          supplier: { select: { id: true, razonSocial: true } },
          items: { include: { insumo: { select: { id: true, nombre: true, unidad: true } } } },
        },
      });

      return { compra: updated, bankTransactionId: bankTxId };
    });

    return NextResponse.json(result);
  }
);
