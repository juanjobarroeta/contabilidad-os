/**
 * GET  /api/construccion/estimaciones/[id]   — detail with partidas
 * PATCH /api/construccion/estimaciones/[id]  — update partidas (mark avance)
 *
 * The PATCH accepts an array of partida avance entries:
 * {
 *   partidas: [
 *     { presupuestoPartidaId: string, cantidadEjecutada: number },
 *     ...
 *   ]
 * }
 *
 * The server computes cantidadAcumulada (sum of all previous estimaciones
 * + this one) and importe (cantidadEjecutada × presupuestoPartida.PU),
 * then updates the estimación's subtotal, IVA, and total.
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

const round2 = (n: number) => Math.round(n * 100) / 100;

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const estimacion = await prisma.estimacion.findUnique({
      where: { id },
      include: {
        proyecto: { select: { id: true, codigo: true, nombre: true, montoContratado: true, anticipoMonto: true, anticipoAmortizado: true, retencionPorc: true } },
        presupuesto: { select: { id: true, nombre: true, montoTotal: true } },
        partidas: {
          include: {
            presupuestoPartida: {
              include: {
                concepto: { select: { codigo: true, descripcion: true, unidad: true } },
              },
            },
          },
          orderBy: { presupuestoPartida: { orden: "asc" } },
        },
      },
    });

    if (!estimacion) throw new AuthzError(404, "Estimación no encontrada");

    await requireWriter(estimacion.companyId, req);
    await requireModule(estimacion.companyId, "CONSTRUCCION");

    return NextResponse.json(estimacion);
  }
);

const patchSchema = z.object({
  partidas: z.array(
    z.object({
      presupuestoPartidaId: z.string().min(1),
      cantidadEjecutada: z.number().nonnegative(),
    })
  ),
});

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const body = await req.json().catch(() => ({}));
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const estimacion = await prisma.estimacion.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true, proyectoId: true, presupuestoId: true, numero: true },
    });
    if (!estimacion) throw new AuthzError(404, "Estimación no encontrada");
    if (estimacion.estado !== "BORRADOR") {
      return NextResponse.json(
        { error: `Solo se pueden editar estimaciones en BORRADOR (estado: ${estimacion.estado})` },
        { status: 422 }
      );
    }

    await requireWriter(estimacion.companyId, req);
    await requireModule(estimacion.companyId, "CONSTRUCCION");

    // For each partida entry, compute cantidadAcumulada from prior estimaciones
    const result = await prisma.$transaction(async (tx) => {
      // Wipe existing partidas on this estimación and recreate
      await tx.estimacionPartida.deleteMany({ where: { estimacionId: id } });

      let subtotal = 0;

      for (const p of parsed.data.partidas) {
        if (p.cantidadEjecutada <= 0) continue;

        // Get the presupuesto partida for PU lookup
        const pp = await tx.presupuestoPartida.findUnique({
          where: { id: p.presupuestoPartidaId },
          select: { id: true, presupuestoId: true, precioUnitario: true, cantidad: true },
        });
        if (!pp || pp.presupuestoId !== estimacion.presupuestoId) continue;

        // Sum cantidadEjecutada from all OTHER estimaciones on this same partida
        const priorAgg = await tx.estimacionPartida.aggregate({
          where: {
            presupuestoPartidaId: p.presupuestoPartidaId,
            estimacion: {
              proyectoId: estimacion.proyectoId,
              id: { not: id }, // exclude current
            },
          },
          _sum: { cantidadEjecutada: true },
        });
        const priorExecuted = priorAgg._sum.cantidadEjecutada ?? 0;
        const cantidadAcumulada = round2(priorExecuted + p.cantidadEjecutada);
        const importe = round2(p.cantidadEjecutada * pp.precioUnitario);
        subtotal += importe;

        await tx.estimacionPartida.create({
          data: {
            estimacionId: id,
            presupuestoPartidaId: p.presupuestoPartidaId,
            cantidadEjecutada: p.cantidadEjecutada,
            cantidadAcumulada,
            importe,
          },
        });
      }

      subtotal = round2(subtotal);
      const iva = round2(subtotal * 0.16);
      const total = round2(subtotal + iva);

      const updated = await tx.estimacion.update({
        where: { id },
        data: { subtotal, iva, total },
      });

      return updated;
    });

    return NextResponse.json(result);
  }
);
