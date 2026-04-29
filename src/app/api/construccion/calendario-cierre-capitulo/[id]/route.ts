/**
 * PATCH /api/construccion/calendario-cierre-capitulo/[id]
 *
 * Editar la planeación interna de Gerardo (sheet 4) — distribución semanal
 * con la que él espera pagar/ejecutar el capítulo. La suma puede ser ≤ 1.0
 * (no obligado a planear el 100%).
 *
 * Body: { pesoPctSemanal: number[] }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const bodySchema = z.object({
  pesoPctSemanal: z.array(z.number().min(0).max(1.5)).min(1).max(96),
});

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const cal = await prisma.calendarioCierreCapitulo.findUnique({
      where: { id },
      include: { template: { select: { companyId: true } } },
    });
    if (!cal) throw new AuthzError(404, "Calendario no encontrado");
    await requireWriter(cal.template.companyId, req);
    await requireModule(cal.template.companyId, "CONSTRUCCION");

    const body = await req.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const updated = await prisma.calendarioCierreCapitulo.update({
      where: { id },
      data: { pesoPctSemanal: parsed.data.pesoPctSemanal },
    });
    return NextResponse.json(updated);
  }
);
