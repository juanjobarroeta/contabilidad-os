import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter, withAuthz, AuthzError } from "@/lib/authz";
import { moneyPush, notificarConstruccion } from "@/lib/construccion/push";

// bankAccountId is accepted for backward-compat with the old caller but ignored:
// registrar el pago ya no toca la cuenta bancaria.
const pagarSchema = z.object({
  bankAccountId: z.string().optional(),
  fecha: z.string().datetime().optional(),
  referencia: z.string().max(120).optional(),
});

/**
 * POST /api/construccion/solicitudes-compra/:id/pagar
 *
 * Marca una requisición APROBADA como PAGADA (operativo, para reflejar compras/
 * costos/avance del proyecto). NUEVA semántica: NO crea movimiento bancario ni
 * postea ledger. El estado de cuenta es fuente de verdad única del CSV importado
 * y el asiento/empate ocurre en la conciliación (CFDI ↔ movimiento), no aquí.
 * (Antes creaba un BankTransaction sintético + asiento 5101/1101 que ensuciaba
 * el banco y se duplicaba al importar el estado de cuenta real.)
 */
export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const body = await req.json().catch(() => ({}));
    const parsed = pagarSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const fecha = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date();

    const solicitud = await prisma.solicitudCompra.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true, folio: true, total: true, creadaPorId: true },
    });
    if (!solicitud) {
      throw new AuthzError(404, "Solicitud no encontrada");
    }

    const { user } = await requireWriter(solicitud.companyId, req);
    await requireModule(solicitud.companyId, "CONSTRUCCION");

    if (solicitud.estado !== "APROBADA") {
      return NextResponse.json(
        {
          error: `Solo se pueden pagar solicitudes APROBADAS (estado actual: ${solicitud.estado})`,
        },
        { status: 422 }
      );
    }

    const updated = await prisma.solicitudCompra.update({
      where: { id: solicitud.id },
      data: { estado: "PAGADA", pagadaAt: fecha },
    });

    // Pagada → avisar a admins y a quien la creó (sin el actor: normalmente
    // tesorería, que ya sabe que pagó).
    void notificarConstruccion({
      companyId: solicitud.companyId,
      destinos: ["ADMIN"],
      userIds: [solicitud.creadaPorId],
      excludeUserId: user.id,
      payload: {
        title: `Requisición ${solicitud.folio} pagada`,
        body: moneyPush(Number(solicitud.total)),
        url: "/requisiciones",
        tag: `solicitud-${solicitud.id}`,
      },
    });

    return NextResponse.json({ solicitud: updated });
  }
);
