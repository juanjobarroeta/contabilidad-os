/**
 * POST /api/construccion/adjudicaciones/:id/pagar
 *
 * Atajo "pagar esta adjudicación": crea un PagoProveedor por el saldo abierto
 * de la adjudicación, totalmente aplicado a ella (cuenta corriente del
 * proveedor). Equivale a POST /pagos-proveedor con una sola aplicación.
 *
 * NO toca el banco ni el ledger: el movimiento real llega por el CSV importado
 * y se empata en la conciliación. Body: { fecha?, referencia?,
 * comprobante?: { data, mime, name }, monto? } — monto permite un pago parcial
 * (default: el saldo completo).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter, withAuthz, AuthzError } from "@/lib/authz";
import { aplicadoDeAdjudicacion, aplicarPago, saldoDe } from "@/lib/construccion/pagos-proveedor";

const pagarSchema = z.object({
  fecha: z.string().datetime().optional(),
  referencia: z.string().max(120).optional(),
  monto: z.number().positive().optional(),
  comprobante: z
    .object({
      data: z.string().min(1),
      mime: z.string().max(120).optional(),
      name: z.string().max(200).optional(),
    })
    .nullable()
    .optional(),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const body = await req.json().catch(() => ({}));
    const parsed = pagarSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { referencia, comprobante } = parsed.data;
    const fecha = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date();

    const adj = await prisma.solicitudAdjudicacion.findUnique({
      where: { id },
      select: {
        id: true,
        companyId: true,
        estado: true,
        total: true,
        supplierId: true,
        supplierNombre: true,
        solicitudId: true,
      },
    });
    if (!adj) throw new AuthzError(404, "Adjudicación no encontrada");

    await requireWriter(adj.companyId, req);
    await requireModule(adj.companyId, "CONSTRUCCION");

    const aplicadoPrevio = await aplicadoDeAdjudicacion(prisma, adj.id);
    const saldo = saldoDe({ ...adj, total: Number(adj.total) }, aplicadoPrevio);
    if (saldo <= 0.01) {
      return NextResponse.json(
        { error: "Esta adjudicación ya está saldada" },
        { status: 409 }
      );
    }
    const monto = Math.min(parsed.data.monto ?? saldo, saldo);

    const result = await prisma.$transaction(async (tx) => {
      const pago = await tx.pagoProveedor.create({
        data: {
          companyId: adj.companyId,
          supplierId: adj.supplierId ?? null,
          supplierNombre: adj.supplierNombre,
          fecha,
          monto,
          referencia: referencia ?? null,
          comprobanteData: comprobante?.data ?? null,
          comprobanteMime: comprobante?.mime ?? null,
          comprobanteName: comprobante?.name ?? null,
        },
      });
      await aplicarPago(tx, { ...pago, monto: Number(pago.monto) }, [{ adjudicacionId: adj.id, monto }], fecha);

      // Espejo en la adjudicación para el panel de detalle (referencia y
      // comprobante del último pago registrado).
      const updated = await tx.solicitudAdjudicacion.update({
        where: { id: adj.id },
        data: {
          referenciaPago: referencia ?? undefined,
          comprobanteData: comprobante?.data ?? undefined,
          comprobanteMime: comprobante?.mime ?? undefined,
          comprobanteName: comprobante?.name ?? undefined,
        },
      });

      return { adjudicacion: updated, pagoId: pago.id, aplicado: monto };
    });

    return NextResponse.json(result);
  }
);
