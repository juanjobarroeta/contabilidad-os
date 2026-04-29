/**
 * PATCH /api/construccion/estimacion-curva-capitulo/[id]
 *
 * Editar una curva del cliente (sheet 5) — actualiza pesoPctSemanal con un
 * arreglo de Floats. El frontend envía el arreglo completo; el server lo
 * valida (longitud = weekCount, sum ≈ 1.0 con tolerancia).
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
    const curva = await prisma.estimacionCurvaCapitulo.findUnique({
      where: { id },
      include: { template: { select: { companyId: true } } },
    });
    if (!curva) throw new AuthzError(404, "Curva no encontrada");
    await requireWriter(curva.template.companyId, req);
    await requireModule(curva.template.companyId, "CONSTRUCCION");

    const body = await req.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const updated = await prisma.estimacionCurvaCapitulo.update({
      where: { id },
      data: { pesoPctSemanal: parsed.data.pesoPctSemanal },
    });
    return NextResponse.json(updated);
  }
);
