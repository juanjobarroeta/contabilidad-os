/**
 * POST /api/construccion/pagos-proveedor/[id]/aplicar
 *
 * Aplica el saldo disponible (anticipo) de un pago existente a adjudicaciones.
 * Caso típico: se pagó un anticipo al proveedor y semanas después se autoriza
 * la requisición que lo consume.
 *
 * Body: { aplicaciones: [{ adjudicacionId, monto }] }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { aplicarPago } from "@/lib/construccion/pagos-proveedor";

const bodySchema = z.object({
  aplicaciones: z
    .array(z.object({ adjudicacionId: z.string().min(1), monto: z.number().positive() }))
    .min(1),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const pago = await prisma.pagoProveedor.findUnique({
      where: { id },
      select: { id: true, companyId: true, supplierId: true, monto: true },
    });
    if (!pago) throw new AuthzError(404, "Pago no encontrado");
    await requireWriter(pago.companyId, req);
    await requireModule(pago.companyId, "CONSTRUCCION");

    try {
      const result = await prisma.$transaction(async (tx) => {
        const aplicado = await aplicarPago(tx, { ...pago, monto: Number(pago.monto) }, parsed.data.aplicaciones, new Date());
        const agg = await tx.pagoAplicacion.aggregate({
          where: { pagoId: pago.id },
          _sum: { monto: true },
        });
        return { aplicado, disponible: Math.max(0, Number(pago.monto) - Number(agg._sum.monto ?? 0)) };
      });
      return NextResponse.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Error al aplicar el pago";
      return NextResponse.json({ error: msg }, { status: 422 });
    }
  }
);
