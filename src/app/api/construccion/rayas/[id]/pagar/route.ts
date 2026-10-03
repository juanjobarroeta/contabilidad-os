/**
 * POST /api/construccion/rayas/[id]/pagar
 *
 * APROBADA → PAGADA. Registra el pago (fecha y referencia del SPEI/efectivo)
 * SIN crear movimiento bancario — igual que gastos y requisiciones: el
 * movimiento real llega con el estado de cuenta importado y se concilia
 * después contra esta raya. (Antes se inventaba un BankTransaction que se
 * duplicaba al importar el estado de cuenta.)
 *
 * Body: {
 *   fecha: ISO date          // cuándo salió el dinero
 *   referencia?: string      // folio SPEI, cheque, "efectivo"…
 *   bankAccountId?: string   // aceptado por compatibilidad; se ignora
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
  bankAccountId: z.string().min(1).optional(),
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
    const fecha = new Date(parsed.data.fecha);
    if (Number.isNaN(fecha.getTime())) {
      return NextResponse.json({ error: "Fecha inválida" }, { status: 400 });
    }

    const raya = await prisma.rayaSemanal.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true },
    });
    if (!raya) throw new AuthzError(404, "Raya no encontrada");
    await requireWriter(raya.companyId, req);
    await requireModule(raya.companyId, "CONSTRUCCION");

    if (raya.estado !== "APROBADA") {
      return NextResponse.json(
        { error: `Transición inválida: ${raya.estado} → PAGADA (autorízala primero)` },
        { status: 422 }
      );
    }

    // Guarda contra doble pago (dos pestañas): sólo pasa si sigue APROBADA.
    const { count } = await prisma.rayaSemanal.updateMany({
      where: { id, estado: "APROBADA" },
      data: {
        estado: "PAGADA",
        pagadaAt: fecha,
        pagoRegistradoAt: new Date(),
        referenciaPago: parsed.data.referencia ?? null,
      },
    });
    if (count === 0) throw new AuthzError(409, "La raya ya fue pagada");

    const updated = await prisma.rayaSemanal.findUnique({
      where: { id },
      include: { cuadrilla: true, bankTransaction: true },
    });
    return NextResponse.json(updated);
  }
);
