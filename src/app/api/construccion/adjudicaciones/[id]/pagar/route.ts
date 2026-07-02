/**
 * POST /api/construccion/adjudicaciones/:id/pagar
 *
 * Registra el pago de UNA adjudicación (un proveedor de una requisición).
 *
 * IMPORTANTE — nueva semántica: registrar el pago NO toca la cuenta bancaria.
 * El estado de cuenta es fuente de verdad única del CSV importado; aquí sólo
 * guardamos el comprobante (SPEI) y marcamos la adjudicación como PAGADA
 * (por conciliar). El asiento contable y el empate con el movimiento bancario
 * real ocurren en la conciliación, no aquí.
 *
 *   POR_PAGAR → PAGADA (pagadaAt, comprobante, referencia)
 *     • NO crea BankTransaction
 *     • NO postea ledger (se postea al conciliar contra el movimiento real)
 *     • el requisición padre pasa a PAGADA cuando todos los proveedores
 *       tienen el pago registrado
 *
 * Body: { fecha?, referencia?, comprobante?: { data, mime, name } }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter, withAuthz, AuthzError } from "@/lib/authz";
import { refreshSolicitudPagoEstado } from "@/lib/construccion/adjudicaciones";

const pagarSchema = z.object({
  fecha: z.string().datetime().optional(),
  referencia: z.string().max(120).optional(),
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
      select: { id: true, companyId: true, estado: true, solicitudId: true },
    });
    if (!adj) throw new AuthzError(404, "Adjudicación no encontrada");

    await requireWriter(adj.companyId, req);
    await requireModule(adj.companyId, "CONSTRUCCION");

    if (adj.estado !== "POR_PAGAR") {
      return NextResponse.json(
        { error: "Esta adjudicación ya tiene el pago registrado" },
        { status: 409 }
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.solicitudAdjudicacion.update({
        where: { id: adj.id },
        data: {
          estado: "PAGADA",
          pagadaAt: fecha,
          referenciaPago: referencia ?? null,
          comprobanteData: comprobante?.data ?? null,
          comprobanteMime: comprobante?.mime ?? null,
          comprobanteName: comprobante?.name ?? null,
        },
      });

      // El requisición padre pasa a PAGADA cuando todos los proveedores tienen
      // el pago registrado (aún por conciliar).
      await refreshSolicitudPagoEstado(tx, adj.solicitudId, fecha);

      return { adjudicacion: updated };
    });

    return NextResponse.json(result);
  }
);
