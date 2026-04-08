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
            conceptoId: true,
            apuVersion: true,
            cantidad: true,
            precioUnitario: true,
            importe: true,
            orden: true,
            zona: true,
            partida: true,
          },
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

    const clone = await prisma.presupuesto.create({
      data: {
        companyId: source.companyId,
        proyectoId: source.proyectoId,
        nombre,
        version: nextVersion,
        estado: "BORRADOR",
        montoTotal: source.montoTotal,
        partidas: {
          create: source.partidas.map((p) => ({
            conceptoId: p.conceptoId,
            apuVersion: p.apuVersion,
            cantidad: p.cantidad,
            precioUnitario: p.precioUnitario,
            importe: p.importe,
            orden: p.orden,
            zona: p.zona,
            partida: p.partida,
          })),
        },
      },
      include: {
        _count: { select: { partidas: true } },
      },
    });

    return NextResponse.json(clone, { status: 201 });
  }
);
