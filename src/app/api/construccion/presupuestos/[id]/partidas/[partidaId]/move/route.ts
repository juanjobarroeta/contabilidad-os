/**
 * POST /api/construccion/presupuestos/[id]/partidas/[partidaId]/move
 *
 * Reparent or reorder a partida within its presupuesto. Used when the
 * user drags a capítulo branch to a new parent or drops a leaf under a
 * different branch in the tree UI.
 *
 * Body:
 *   {
 *     parentPartidaId?: string | null,  // new parent (null = root)
 *     orden?: number,                    // new position among siblings
 *   }
 *
 * Server guarantees:
 *   - Parent (when provided) belongs to the same presupuesto AND is a
 *     rollup branch.
 *   - No cycles: target parent is not a descendant of the moved node.
 *   - Recomputes nivel + codigo for the moved node AND all descendants.
 *   - Only works on BORRADOR / EN_EJECUCION presupuestos.
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

const moveSchema = z.object({
  parentPartidaId: z.string().min(1).nullable().optional(),
  orden: z.number().int().nonnegative().optional(),
});

type PartidaLite = {
  id: string;
  presupuestoId: string;
  parentPartidaId: string | null;
  nivel: number;
  codigo: string | null;
};

export const POST = withAuthz(
  async (
    req: Request,
    ctx: { params: Promise<{ id: string; partidaId: string }> }
  ) => {
    const { id, partidaId } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const parsed = moveSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      );
    }

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
    if (
      partida.presupuesto.estado !== "BORRADOR" &&
      partida.presupuesto.estado !== "EN_EJECUCION"
    ) {
      return NextResponse.json(
        { error: `No se puede mover en estado ${partida.presupuesto.estado}` },
        { status: 422 }
      );
    }

    // Validate new parent + cycle check
    let newParent: PartidaLite | null = null;
    if (parsed.data.parentPartidaId !== undefined && parsed.data.parentPartidaId !== null) {
      const p = await prisma.presupuestoPartida.findUnique({
        where: { id: parsed.data.parentPartidaId },
        select: {
          id: true,
          presupuestoId: true,
          parentPartidaId: true,
          nivel: true,
          codigo: true,
          esRollup: true,
        },
      });
      if (!p || p.presupuestoId !== id) {
        return NextResponse.json({ error: "parentPartidaId inválido" }, { status: 400 });
      }
      if (!p.esRollup) {
        return NextResponse.json(
          { error: "El padre debe ser una rama" },
          { status: 400 }
        );
      }
      // Walk ancestors: if we encounter partidaId, it's a cycle
      let cursor: string | null = p.parentPartidaId;
      while (cursor) {
        if (cursor === partidaId) {
          return NextResponse.json({ error: "Ciclo detectado" }, { status: 400 });
        }
        const anc = await prisma.presupuestoPartida.findUnique({
          where: { id: cursor },
          select: { parentPartidaId: true },
        });
        cursor = anc?.parentPartidaId ?? null;
      }
      newParent = p;
    }

    const newParentId = parsed.data.parentPartidaId ?? null;
    const newParentNivel = newParent?.nivel ?? -1;
    const newParentCodigo = newParent?.codigo ?? null;

    await prisma.$transaction(async (tx) => {
      // Compute new orden (append by default)
      let orden = parsed.data.orden;
      if (orden === undefined) {
        const tail = await tx.presupuestoPartida.aggregate({
          where: { presupuestoId: id, parentPartidaId: newParentId },
          _max: { orden: true },
        });
        orden = (tail._max.orden ?? -1) + 1;
      }

      // Count siblings before update to assign codigo suffix
      const siblingCount = await tx.presupuestoPartida.count({
        where: { presupuestoId: id, parentPartidaId: newParentId },
      });
      const newCodigo = newParentCodigo
        ? `${newParentCodigo}.${siblingCount + 1}`
        : `${siblingCount + 1}`;

      await tx.presupuestoPartida.update({
        where: { id: partidaId },
        data: {
          parentPartidaId: newParentId,
          nivel: newParentNivel + 1,
          codigo: newCodigo,
          orden,
        },
      });

      // Recompute nivel/codigo for descendants via BFS
      type Node = { id: string; nivel: number; codigo: string };
      const queue: Node[] = [
        { id: partidaId, nivel: newParentNivel + 1, codigo: newCodigo },
      ];
      while (queue.length) {
        const cur = queue.shift()!;
        const children = await tx.presupuestoPartida.findMany({
          where: { parentPartidaId: cur.id },
          select: { id: true },
          orderBy: { orden: "asc" },
        });
        for (let i = 0; i < children.length; i++) {
          const childCodigo = `${cur.codigo}.${i + 1}`;
          const childNivel = cur.nivel + 1;
          await tx.presupuestoPartida.update({
            where: { id: children[i].id },
            data: { nivel: childNivel, codigo: childCodigo },
          });
          queue.push({ id: children[i].id, nivel: childNivel, codigo: childCodigo });
        }
      }
    });

    const refreshed = await prisma.presupuestoPartida.findUnique({
      where: { id: partidaId },
      select: {
        id: true,
        parentPartidaId: true,
        nivel: true,
        codigo: true,
        orden: true,
      },
    });

    return NextResponse.json({ partida: refreshed });
  }
);
