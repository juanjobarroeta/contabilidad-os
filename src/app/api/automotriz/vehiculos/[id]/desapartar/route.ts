/**
 * POST /api/automotriz/vehiculos/[id]/desapartar — APARTADO → DISPONIBLE.
 * Se limpia la liga al cliente (el trato se cayó); el historial queda en el
 * perfil del contacto vía sus facturas, no en la unidad.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const v = await prisma.vehiculo.findUnique({ where: { id }, select: { id: true, companyId: true, estado: true } });
    if (!v) throw new AuthzError(404, "Unidad no encontrada");
    await requireWriter(v.companyId, req);
    await requireModule(v.companyId, "AUTOMOTRIZ", req);
    if (v.estado !== "APARTADO") {
      return NextResponse.json({ error: `Sólo se des-aparta una unidad APARTADA (actual: ${v.estado})` }, { status: 422 });
    }
    const updated = await prisma.vehiculo.update({
      where: { id },
      data: { estado: "DISPONIBLE", clienteId: null },
    });
    return NextResponse.json(updated);
  }
);
