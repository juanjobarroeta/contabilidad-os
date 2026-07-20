import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  nombre: z.string().trim().min(1).max(120).optional(),
  precio: z.number().nonnegative().optional(),
  garrafones: z.number().int().min(0).optional(),
  ivaTasa: z.number().min(0).max(0.16).optional(),
  activo: z.boolean().optional(),
});

// PATCH /api/purificadora/productos/[id] — editar / activar / desactivar.
export const PATCH = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const producto = await prisma.purifProducto.findUnique({
    where: { id },
    select: { id: true, companyId: true },
  });
  if (!producto) throw new AuthzError(404, "Producto no encontrado");

  await requireWriter(producto.companyId, req);
  await requireModule(producto.companyId, "PURIFICADORA", req);

  try {
    const updated = await prisma.purifProducto.update({ where: { id }, data: parsed.data });
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json(
      { error: "Ya existe un producto con ese nombre" },
      { status: 409 }
    );
  }
});
