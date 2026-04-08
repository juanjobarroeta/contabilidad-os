/**
 * GET /api/construccion/presupuestos/[id]
 *
 * Returns a single presupuesto with all partidas expanded (concepto +
 * zona + partida + cantidad + PU snapshot + importe). Used by the bartiz
 * PresupuestoDetalle page to render the grouped table matching the
 * partner's PDF layout.
 *
 * PATCH /api/construccion/presupuestos/[id]
 *
 * State-machine transition endpoint. Used to mark a presupuesto as
 * APROBADO (and optionally set the sibling as RECHAZADO via a separate
 * call) after the customer meeting. Body: { estado, nombre? }.
 *
 * Keeping it minimal for v1: no mass edit of partidas here. For that,
 * we'll add POST /partidas once we have a UI that needs it.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireMembership,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

const patchSchema = z.object({
  estado: z
    .enum(["BORRADOR", "APROBADO", "EN_EJECUCION", "CERRADO", "RECHAZADO"])
    .optional(),
  nombre: z.string().min(1).optional(),
});

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const presupuesto = await prisma.presupuesto.findUnique({
      where: { id },
      include: {
        proyecto: {
          select: { id: true, codigo: true, nombre: true, ubicacion: true },
        },
        partidas: {
          include: {
            concepto: {
              select: {
                id: true,
                codigo: true,
                descripcion: true,
                unidad: true,
              },
            },
          },
          orderBy: [{ zona: "asc" }, { partida: "asc" }, { orden: "asc" }],
        },
      },
    });

    if (!presupuesto) {
      throw new AuthzError(404, "Presupuesto no encontrado");
    }

    await requireMembership(presupuesto.companyId, undefined, req);
    await requireModule(presupuesto.companyId, "CONSTRUCCION");

    return NextResponse.json(presupuesto);
  }
);

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const presupuesto = await prisma.presupuesto.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true, proyectoId: true },
    });
    if (!presupuesto) {
      throw new AuthzError(404, "Presupuesto no encontrado");
    }

    await requireWriter(presupuesto.companyId, req);
    await requireModule(presupuesto.companyId, "CONSTRUCCION");

    // Basic state-machine validation. Not bulletproof but catches obvious
    // bad transitions (e.g. CERRADO → BORRADOR).
    if (parsed.data.estado) {
      const valid: Record<string, string[]> = {
        BORRADOR:     ["APROBADO", "RECHAZADO", "BORRADOR"],
        APROBADO:     ["EN_EJECUCION", "CERRADO", "APROBADO"],
        EN_EJECUCION: ["CERRADO", "EN_EJECUCION"],
        CERRADO:      ["CERRADO"],
        RECHAZADO:    ["BORRADOR", "RECHAZADO"],
      };
      if (!valid[presupuesto.estado]?.includes(parsed.data.estado)) {
        return NextResponse.json(
          {
            error: `Transición inválida: ${presupuesto.estado} → ${parsed.data.estado}`,
          },
          { status: 422 }
        );
      }
    }

    const updated = await prisma.presupuesto.update({
      where: { id },
      data: {
        ...(parsed.data.estado !== undefined && { estado: parsed.data.estado }),
        ...(parsed.data.nombre !== undefined && { nombre: parsed.data.nombre }),
      },
    });

    return NextResponse.json(updated);
  }
);
