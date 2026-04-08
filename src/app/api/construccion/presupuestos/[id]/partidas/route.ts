/**
 * POST /api/construccion/presupuestos/[id]/partidas
 *
 * Add a new partida to a presupuesto. The server:
 *   - looks up the concepto and its current APU
 *   - snapshots the APU's precioUnitario onto the new partida row
 *     (so future APU edits don't retroactively change this presupuesto)
 *   - computes importe = cantidad × precioUnitario
 *   - recomputes the presupuesto's montoTotal = sum of all partida importes
 *   - returns the new partida with concepto joined
 *
 * Guard: only allowed when parent presupuesto is in BORRADOR. APROBADO /
 * EN_EJECUCION / CERRADO presupuestos are frozen — changes require a
 * clone first.
 *
 * Body: {
 *   conceptoId: string,
 *   cantidad: number > 0,
 *   zona?: string,
 *   partida?: string,
 *   orden?: number
 * }
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

const createSchema = z.object({
  conceptoId: z.string().min(1),
  cantidad: z.number().positive(),
  zona: z.string().max(80).optional(),
  partida: z.string().max(80).optional(),
  orden: z.number().int().nonnegative().optional(),
});

const round2 = (n: number): number => Math.round(n * 100) / 100;

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const body = await req.json().catch(() => ({}));
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const data = parsed.data;

    const presupuesto = await prisma.presupuesto.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true },
    });
    if (!presupuesto) {
      throw new AuthzError(404, "Presupuesto no encontrado");
    }

    await requireWriter(presupuesto.companyId, req);
    await requireModule(presupuesto.companyId, "CONSTRUCCION");

    if (presupuesto.estado !== "BORRADOR") {
      return NextResponse.json(
        {
          error: `Solo se pueden editar presupuestos en BORRADOR (estado actual: ${presupuesto.estado}). Clónalo primero.`,
        },
        { status: 422 }
      );
    }

    // Cross-company check + pull current PU
    const concepto = await prisma.concepto.findUnique({
      where: { id: data.conceptoId },
      include: {
        apuActual: {
          select: { id: true, version: true, precioUnitario: true },
        },
      },
    });
    if (!concepto || concepto.companyId !== presupuesto.companyId) {
      return NextResponse.json({ error: "Concepto inválido" }, { status: 400 });
    }

    const precioUnitario = concepto.apuActual?.precioUnitario ?? 0;
    const importe = round2(data.cantidad * precioUnitario);

    // If orden not supplied, append
    let orden = data.orden;
    if (orden === undefined) {
      const tail = await prisma.presupuestoPartida.aggregate({
        where: {
          presupuestoId: id,
          zona: data.zona ?? null,
          partida: data.partida ?? null,
        },
        _max: { orden: true },
      });
      orden = (tail._max.orden ?? -1) + 1;
    }

    // Atomic: insert + recompute montoTotal
    const result = await prisma.$transaction(async (tx) => {
      const created = await tx.presupuestoPartida.create({
        data: {
          presupuestoId: id,
          conceptoId: concepto.id,
          apuVersion: concepto.apuActual?.version ?? 1,
          cantidad: data.cantidad,
          precioUnitario,
          importe,
          orden,
          zona: data.zona,
          partida: data.partida,
        },
        include: {
          concepto: {
            select: { id: true, codigo: true, descripcion: true, unidad: true },
          },
        },
      });

      const agg = await tx.presupuestoPartida.aggregate({
        where: { presupuestoId: id },
        _sum: { importe: true },
      });
      const montoTotal = round2(agg._sum.importe ?? 0);

      const updatedPresupuesto = await tx.presupuesto.update({
        where: { id },
        data: { montoTotal },
        select: { id: true, montoTotal: true },
      });

      return { partida: created, presupuesto: updatedPresupuesto };
    });

    return NextResponse.json(result, { status: 201 });
  }
);
