import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { categoriaGastoSchema } from "@/lib/purificadora/categorias";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  nombre: z.string().trim().min(1).max(120).optional(),
  unidad: z.string().trim().min(1).max(30).optional(),
  categoria: categoriaGastoSchema.optional(),
  activo: z.boolean().optional(),
});

// PATCH /api/purificadora/insumos/[id]
export const PATCH = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const insumo = await prisma.purifInsumo.findUnique({
    where: { id },
    select: { id: true, companyId: true },
  });
  if (!insumo) throw new AuthzError(404, "Insumo no encontrado");

  await requireWriter(insumo.companyId, req);
  await requireModule(insumo.companyId, "PURIFICADORA", req);

  try {
    const updated = await prisma.purifInsumo.update({ where: { id }, data: parsed.data });
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ error: "Ya existe un insumo con ese nombre" }, { status: 409 });
  }
});
