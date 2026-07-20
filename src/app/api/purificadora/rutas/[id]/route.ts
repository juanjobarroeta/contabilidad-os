import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  nombre: z.string().trim().min(1).max(80).optional(),
  activo: z.boolean().optional(),
});

// PATCH /api/purificadora/rutas/[id]
export const PATCH = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const ruta = await prisma.purifRuta.findUnique({
    where: { id },
    select: { id: true, companyId: true },
  });
  if (!ruta) throw new AuthzError(404, "Ruta no encontrada");

  await requireWriter(ruta.companyId, req);
  await requireModule(ruta.companyId, "PURIFICADORA", req);

  try {
    const updated = await prisma.purifRuta.update({ where: { id }, data: parsed.data });
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ error: "Ya existe una ruta con ese nombre" }, { status: 409 });
  }
});
