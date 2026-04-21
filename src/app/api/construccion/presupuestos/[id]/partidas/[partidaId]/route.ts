/**
 * PATCH /api/construccion/presupuestos/[id]/partidas/[partidaId]
 * DELETE /api/construccion/presupuestos/[id]/partidas/[partidaId]
 *
 * Edit or remove a single partida on a BORRADOR presupuesto. The server
 * recomputes both the partida's importe (on cantidad change) and the
 * parent presupuesto's montoTotal in one transaction.
 *
 * Only cantidad is editable — the PU is a frozen snapshot on purpose
 * (so APU catalog edits don't retroactively change approved budgets).
 * To change the PU you'd have to delete + re-add the line, which is
 * the correct audit behavior.
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
  cantidad: z.number().positive().optional(),
  zona: z.string().max(80).nullable().optional(),
  partida: z.string().max(80).nullable().optional(),
  orden: z.number().int().nonnegative().optional(),
  notas: z.string().nullable().optional(),
});

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Shared guard + recompute helper.
 * Returns { presupuesto } after any mutation so the caller can immediately
 * send the fresh montoTotal back to the client.
 */
async function loadAndGuard(
  id: string,
  partidaId: string,
  req: Request
) {
  const partida = await prisma.presupuestoPartida.findUnique({
    where: { id: partidaId },
    include: {
      presupuesto: {
        select: { id: true, companyId: true, estado: true },
      },
    },
  });
  if (!partida || partida.presupuestoId !== id) {
    throw new AuthzError(404, "Partida no encontrada");
  }
  await requireWriter(partida.presupuesto.companyId, req);
  await requireModule(partida.presupuesto.companyId, "CONSTRUCCION");
  if (partida.presupuesto.estado !== "BORRADOR" && partida.presupuesto.estado !== "EN_EJECUCION") {
    throw new AuthzError(
      422,
      `Solo se pueden editar presupuestos en BORRADOR (estado actual: ${partida.presupuesto.estado}). Clónalo primero.`
    );
  }
  return partida;
}

async function recomputeTotal(tx: typeof prisma, presupuestoId: string) {
  const agg = await tx.presupuestoPartida.aggregate({
    where: { presupuestoId },
    _sum: { importe: true },
  });
  const montoTotal = round2(agg._sum.importe ?? 0);
  return tx.presupuesto.update({
    where: { id: presupuestoId },
    data: { montoTotal },
    select: { id: true, montoTotal: true },
  });
}

export const PATCH = withAuthz(
  async (
    req: Request,
    ctx: { params: Promise<{ id: string; partidaId: string }> }
  ) => {
    const { id, partidaId } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const partida = await loadAndGuard(id, partidaId, req);

    const nextCantidad = parsed.data.cantidad ?? partida.cantidad;
    const nextImporte = round2(nextCantidad * partida.precioUnitario);

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.presupuestoPartida.update({
        where: { id: partidaId },
        data: {
          ...(parsed.data.cantidad !== undefined && {
            cantidad: nextCantidad,
            importe: nextImporte,
          }),
          ...(parsed.data.zona !== undefined && { zona: parsed.data.zona }),
          ...(parsed.data.partida !== undefined && {
            partida: parsed.data.partida,
          }),
          ...(parsed.data.orden !== undefined && { orden: parsed.data.orden }),
          ...(parsed.data.notas !== undefined && { notas: parsed.data.notas }),
        },
        include: {
          concepto: {
            select: { id: true, codigo: true, descripcion: true, unidad: true },
          },
        },
      });
      const presupuesto = await recomputeTotal(
        tx as unknown as typeof prisma,
        id
      );
      return { partida: updated, presupuesto };
    });

    return NextResponse.json(result);
  }
);

export const DELETE = withAuthz(
  async (
    req: Request,
    ctx: { params: Promise<{ id: string; partidaId: string }> }
  ) => {
    const { id, partidaId } = await ctx.params;
    await loadAndGuard(id, partidaId, req);

    const result = await prisma.$transaction(async (tx) => {
      await tx.presupuestoPartida.delete({ where: { id: partidaId } });
      const presupuesto = await recomputeTotal(
        tx as unknown as typeof prisma,
        id
      );
      return { deleted: partidaId, presupuesto };
    });

    return NextResponse.json(result);
  }
);
