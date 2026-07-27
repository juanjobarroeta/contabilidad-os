/**
 * POST /api/automotriz/vehiculos/[id]/apartar — DISPONIBLE → APARTADO.
 * Marcador puro (cliente/vendedor opcionales); el anticipo con dinero llega
 * con el flujo de Pedido (fase 1), donde se postea a 2103.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const schema = z.object({
  clienteId: z.string().nullable().optional(),
  vendedorId: z.string().nullable().optional(),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const parsed = schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

    const v = await prisma.vehiculo.findUnique({ where: { id }, select: { id: true, companyId: true, estado: true } });
    if (!v) throw new AuthzError(404, "Unidad no encontrada");
    await requireWriter(v.companyId, req);
    await requireModule(v.companyId, "AUTOMOTRIZ", req);
    if (v.estado !== "DISPONIBLE") {
      return NextResponse.json({ error: `Sólo se apartan unidades DISPONIBLES (actual: ${v.estado})` }, { status: 422 });
    }

    for (const [campo, modelo] of [["clienteId", "customer"], ["vendedorId", "employee"]] as const) {
      const val = parsed.data[campo];
      if (val) {
        const row = await (prisma[modelo] as never as { findUnique: (a: unknown) => Promise<{ companyId: string } | null> })
          .findUnique({ where: { id: val }, select: { companyId: true } });
        if (!row || row.companyId !== v.companyId) {
          return NextResponse.json({ error: `${campo} inválido` }, { status: 400 });
        }
      }
    }

    const updated = await prisma.vehiculo.update({
      where: { id },
      data: {
        estado: "APARTADO",
        clienteId: parsed.data.clienteId ?? undefined,
        vendedorId: parsed.data.vendedorId ?? undefined,
      },
    });
    return NextResponse.json(updated);
  }
);
