/**
 * POST /api/hospital/ayuda/[id]/valoracion { util: boolean, comentario? } → { ok: true }
 *
 * 👍/👎 de quien hizo la pregunta (sólo esa persona; puede cambiarla). El
 * comentario («¿qué esperabas?») es lo que más enseña para mejorar la guía.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireUser } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error, errorZod } from "@/lib/hospital/http";

const schema = z.object({
  util: z.boolean(),
  comentario: z.string().trim().max(1000).nullable().optional(),
});

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);

  const user = await requireUser(req);
  const fila = await prisma.hospAyudaPregunta.findUnique({ where: { id }, select: { companyId: true, userId: true } });
  if (!fila || fila.userId !== user.id) return error("Pregunta no encontrada", 404);
  await requireMembership(fila.companyId, undefined, req);
  await requireModule(fila.companyId, "HOSPITAL", req);

  await prisma.hospAyudaPregunta.update({
    where: { id },
    data: { util: parsed.data.util, comentario: parsed.data.comentario || null, valoradaAt: new Date() },
  });
  return NextResponse.json({ ok: true });
});
