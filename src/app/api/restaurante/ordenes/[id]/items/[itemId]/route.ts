/**
 * PATCH  /api/restaurante/ordenes/[id]/items/[itemId]
 * DELETE /api/restaurante/ordenes/[id]/items/[itemId]
 *
 * PATCH drives the kitchen flow (estadoCocina: PENDIENTE → EN_PREPARACION →
 * LISTO → ENTREGADO) and allows quantity edits while the item is PENDIENTE.
 * DELETE cancels the item (soft: estadoCocina = CANCELADO) while the order
 * is open and the item hasn't been delivered.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const patchSchema = z.object({
  estadoCocina: z.enum(["PENDIENTE", "EN_PREPARACION", "LISTO", "ENTREGADO"]).optional(),
  cantidad: z.number().positive().optional(),
  notas: z.string().max(300).nullable().optional(),
});

async function loadItem(id: string, itemId: string) {
  const item = await prisma.restOrdenItem.findUnique({
    where: { id: itemId },
    include: { orden: { select: { id: true, companyId: true, estado: true } } },
  });
  if (!item || item.orden.id !== id) throw new AuthzError(404, "Partida no encontrada");
  return item;
}

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string; itemId: string }> }) => {
    const { id, itemId } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const item = await loadItem(id, itemId);
    await requireWriter(item.orden.companyId, req);
    await requireModule(item.orden.companyId, "RESTAURANTE", req);

    if (item.estadoCocina === "CANCELADO") {
      return NextResponse.json({ error: "La partida está cancelada" }, { status: 422 });
    }
    if (parsed.data.cantidad !== undefined) {
      if (item.orden.estado !== "ABIERTA" || item.estadoCocina !== "PENDIENTE") {
        return NextResponse.json(
          { error: "Sólo se puede cambiar la cantidad de partidas pendientes en órdenes abiertas" },
          { status: 422 }
        );
      }
    }

    const updated = await prisma.restOrdenItem.update({
      where: { id: itemId },
      data: {
        ...parsed.data,
        ...(parsed.data.estadoCocina === "LISTO" && !item.listoAt
          ? { listoAt: new Date() }
          : {}),
      },
      include: { menuItem: { select: { id: true, nombre: true } } },
    });
    return NextResponse.json(updated);
  }
);

export const DELETE = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string; itemId: string }> }) => {
    const { id, itemId } = await ctx.params;

    const item = await loadItem(id, itemId);
    await requireWriter(item.orden.companyId, req);
    await requireModule(item.orden.companyId, "RESTAURANTE", req);

    if (item.orden.estado !== "ABIERTA") {
      return NextResponse.json(
        { error: "La orden ya no está abierta" },
        { status: 422 }
      );
    }
    if (item.estadoCocina === "ENTREGADO") {
      return NextResponse.json(
        { error: "No se puede cancelar una partida ya entregada" },
        { status: 422 }
      );
    }

    const updated = await prisma.restOrdenItem.update({
      where: { id: itemId },
      data: { estadoCocina: "CANCELADO" },
      include: { menuItem: { select: { id: true, nombre: true } } },
    });
    return NextResponse.json(updated);
  }
);
