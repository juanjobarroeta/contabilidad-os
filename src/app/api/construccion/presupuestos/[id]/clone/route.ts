/**
 * POST /api/construccion/presupuestos/[id]/clone
 *
 * Deep copy of an existing presupuesto. Creates a new presupuesto with a
 * fresh version number (max existing + 1 on the same proyecto), copies
 * every partida as-is (preserving cantidad, PU snapshot, zona, partida,
 * importe), and returns the new row.
 *
 * Use case: the customer negotiates during the meeting. You clone the
 * reference presupuesto (e.g. "Rehabilitación Integral") into a v3
 * "Presupuesto Negociado" and edit the clone's partidas live while the
 * original stays untouched for audit.
 *
 * Body: { nombre?: string } — optional custom label. Defaults to
 *       `${source.nombre} (Editado)`.
 *
 * Clone can be run on any estado (BORRADOR / APROBADO / EN_EJECUCION /
 * CERRADO / RECHAZADO) — the new copy starts fresh in BORRADOR regardless.
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

const cloneSchema = z.object({
  nombre: z.string().min(1).max(120).optional(),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const body = await req.json().catch(() => ({}));
    const parsed = cloneSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const source = await prisma.presupuesto.findUnique({
      where: { id },
      include: {
        partidas: {
          select: {
            id: true,
            conceptoId: true,
            apuVersion: true,
            cantidad: true,
            precioUnitario: true,
            importe: true,
            orden: true,
            zona: true,
            partida: true,
            parentPartidaId: true,
            nivel: true,
            codigo: true,
            esRollup: true,
            unidadProyectoId: true,
          },
          orderBy: { orden: "asc" },
        },
      },
    });
    if (!source) {
      throw new AuthzError(404, "Presupuesto no encontrado");
    }

    await requireWriter(source.companyId, req);
    await requireModule(source.companyId, "CONSTRUCCION");

    // Compute the next available version number for this proyecto
    const maxVersion = await prisma.presupuesto.aggregate({
      where: { proyectoId: source.proyectoId },
      _max: { version: true },
    });
    const nextVersion = (maxVersion._max.version ?? 0) + 1;

    const nombre =
      parsed.data.nombre ??
      `${source.nombre ?? `Presupuesto v${source.version}`} (Editado)`;

    // Two-pass clone so parentPartidaId can be rewired to the new IDs.
    const clone = await prisma.$transaction(async (tx) => {
      const created = await tx.presupuesto.create({
        data: {
          companyId: source.companyId,
          proyectoId: source.proyectoId,
          nombre,
          version: nextVersion,
          estado: "BORRADOR",
          montoTotal: source.montoTotal,
        },
      });

      const idMap = new Map<string, string>();
      for (const p of source.partidas) {
        const newP = await tx.presupuestoPartida.create({
          data: {
            presupuestoId: created.id,
            conceptoId: p.conceptoId,
            apuVersion: p.apuVersion,
            cantidad: p.cantidad,
            precioUnitario: p.precioUnitario,
            importe: p.importe,
            orden: p.orden,
            zona: p.zona,
            partida: p.partida,
            nivel: p.nivel,
            codigo: p.codigo,
            esRollup: p.esRollup,
            unidadProyectoId: p.unidadProyectoId,
          },
          select: { id: true },
        });
        idMap.set(p.id, newP.id);
      }
      for (const p of source.partidas) {
        if (!p.parentPartidaId) continue;
        const newParentId = idMap.get(p.parentPartidaId);
        if (!newParentId) continue;
        await tx.presupuestoPartida.update({
          where: { id: idMap.get(p.id)! },
          data: { parentPartidaId: newParentId },
        });
      }

      return tx.presupuesto.findUnique({
        where: { id: created.id },
        include: { _count: { select: { partidas: true } } },
      });
    });

    return NextResponse.json(clone, { status: 201 });
  }
);
