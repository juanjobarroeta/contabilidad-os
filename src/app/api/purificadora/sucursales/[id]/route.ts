import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  nombre: z.string().trim().min(1).max(120).optional(),
  activo: z.boolean().optional(),
});

// PATCH /api/purificadora/sucursales/[id]
export const PATCH = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const sucursal = await prisma.purifSucursal.findUnique({
    where: { id },
    select: { id: true, companyId: true },
  });
  if (!sucursal) throw new AuthzError(404, "Sucursal no encontrada");

  await requireWriter(sucursal.companyId, req);
  await requireModule(sucursal.companyId, "PURIFICADORA", req);

  try {
    const updated = await prisma.purifSucursal.update({ where: { id }, data: parsed.data });
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json(
      { error: "Ese cliente ya tiene una sucursal con ese nombre" },
      { status: 409 }
    );
  }
});
