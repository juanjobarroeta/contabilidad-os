/**
 * PATCH  /api/construccion/gastos/[id]  — edit (while PENDIENTE only)
 * DELETE /api/construccion/gastos/[id]  — delete (PENDIENTE only)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

const patchSchema = z.object({
  beneficiarioNombre: z.string().min(1).max(200).optional(),
  descripcion: z.string().min(1).max(500).optional(),
  importe: z.number().positive().optional(),
  presupuestoPartidaId: z.string().min(1).nullable().optional(),
  insumoId: z.string().min(1).nullable().optional(),
  bankAccountId: z.string().min(1).optional(),
  comprobanteUrl: z.string().max(1000).nullable().optional(),
  notas: z.string().max(1000).nullable().optional(),
  estado: z.enum(["PENDIENTE", "RECHAZADO"]).optional(),
  // Indirecto flag + categoría — Katia can set these from the 3-button picker.
  // Writing indirecto=true auto-clears any stray partida/insumo link since
  // the two paths are mutually exclusive.
  indirecto: z.boolean().optional(),
  categoriaIndirecto: z.string().max(40).nullable().optional(),
});

async function loadGasto(id: string, req: Request) {
  const gasto = await prisma.gasto.findUnique({
    where: { id },
    select: { id: true, companyId: true, estado: true },
  });
  if (!gasto) throw new AuthzError(404, "Gasto no encontrado");
  await requireWriter(gasto.companyId, req);
  await requireModule(gasto.companyId, "CONSTRUCCION");
  return gasto;
}

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const gasto = await loadGasto(id, req);
    const body = await req.json().catch(() => ({}));
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    if (gasto.estado !== "PENDIENTE" && parsed.data.estado !== "RECHAZADO") {
      return NextResponse.json(
        { error: `Solo se pueden editar gastos en PENDIENTE (actual: ${gasto.estado})` },
        { status: 422 }
      );
    }
    // If the client sets indirecto=true, clear any partida/insumo link
    // (the two branches are mutually exclusive). And vice-versa — if
    // they set a partida/insumo, clear indirecto + categoría.
    const data: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.indirecto === true) {
      data.presupuestoPartidaId = null;
      data.insumoId = null;
    }
    if (parsed.data.presupuestoPartidaId || parsed.data.insumoId) {
      data.indirecto = false;
      data.categoriaIndirecto = null;
    }

    const updated = await prisma.gasto.update({
      where: { id },
      data,
      include: {
        bankAccount: { select: { id: true, banco: true, nombre: true } },
        presupuestoPartida: {
          select: { id: true, codigo: true, concepto: { select: { codigo: true, descripcion: true } } },
        },
        insumo: { select: { id: true, codigo: true, descripcion: true } },
      },
    });
    return NextResponse.json(updated);
  }
);

export const DELETE = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const gasto = await loadGasto(id, req);
    if (gasto.estado !== "PENDIENTE") {
      return NextResponse.json(
        { error: `Solo se pueden eliminar gastos en PENDIENTE (actual: ${gasto.estado})` },
        { status: 422 }
      );
    }
    await prisma.gasto.delete({ where: { id } });
    return NextResponse.json({ deleted: id });
  }
);
