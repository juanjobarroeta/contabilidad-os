/**
 * GET    /api/construccion/proyectos/[id]/estimacion-template
 * POST   /api/construccion/proyectos/[id]/estimacion-template/bootstrap (this file handles both)
 * DELETE /api/construccion/proyectos/[id]/estimacion-template
 *
 * The plantilla de estimaciones — Gerardo's compacted billing structure.
 * Auto-created on /presupuesto/import; this endpoint exposes it for the UI
 * and lets users re-bootstrap projects imported before Run 2A shipped.
 *
 * GET response includes:
 *   { template: { id, partidas: [...], curvas: [...] }, proyecto: { viviendasObjetivo, weekCount, aplicaIva } }
 *
 * POST { action: "bootstrap" } — wipes existing template (if any) and
 * runs the auto-bootstrap. Useful for old projects or to reset after
 * Gerardo's manual edits go off the rails. Idempotent on re-run.
 *
 * DELETE — drops the entire template + curvas. Estimaciones already created
 * will keep their snapshot rows (the cascade on EstimacionTemplatePartida →
 * EstimacionPartida is set null, so historic estimaciones survive — but new
 * ones can't be created until a template exists again).
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
import { bootstrapEstimacionTemplate } from "@/lib/construccion/estimacion-template-bootstrap";
import { CURVA_DEFAULT_WEEK_COUNT } from "@/lib/construccion/curva-vivienda-default";

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const proyecto = await prisma.proyecto.findUnique({
      where: { id },
      select: {
        id: true,
        companyId: true,
        viviendasObjetivo: true,
        weekCount: true,
        aplicaIva: true,
      },
    });
    if (!proyecto) throw new AuthzError(404, "Proyecto no encontrado");
    await requireMembership(proyecto.companyId, undefined, req);
    await requireModule(proyecto.companyId, "CONSTRUCCION");

    const template = await prisma.estimacionTemplate.findUnique({
      where: { proyectoId: id },
      include: {
        partidas: {
          include: {
            presupuestoPartida: {
              select: { codigo: true, partida: true, importe: true },
            },
          },
          orderBy: { orden: "asc" },
        },
        curvas: { orderBy: { capituloCode: "asc" } },
      },
    });

    return NextResponse.json({
      proyecto: {
        id: proyecto.id,
        viviendasObjetivo: proyecto.viviendasObjetivo,
        weekCount: proyecto.weekCount,
        aplicaIva: proyecto.aplicaIva,
      },
      template,
      hasPresupuesto: !!(await prisma.presupuesto.findFirst({
        where: { proyectoId: id },
        select: { id: true },
      })),
    });
  }
);

const postSchema = z.object({
  action: z.literal("bootstrap"),
  // Optional overrides — pass these to update the proyecto fields at the
  // same time we rebuild the template (one-shot configuration).
  viviendasObjetivo: z.number().int().positive().nullable().optional(),
  weekCount: z.number().int().positive().nullable().optional(),
  aplicaIva: z.boolean().optional(),
  fechaInicio: z.string().datetime().nullable().optional(),
  fechaFinPlan: z.string().datetime().nullable().optional(),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const proyecto = await prisma.proyecto.findUnique({
      where: { id },
      select: { id: true, companyId: true, weekCount: true },
    });
    if (!proyecto) throw new AuthzError(404, "Proyecto no encontrado");
    await requireWriter(proyecto.companyId, req);
    await requireModule(proyecto.companyId, "CONSTRUCCION");

    const body = await req.json().catch(() => ({}));
    const parsed = postSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Payload inválido", detail: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // Need a presupuesto to bootstrap from — the latest one is the source.
    const presupuesto = await prisma.presupuesto.findFirst({
      where: { proyectoId: id },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!presupuesto) {
      return NextResponse.json(
        { error: "Importa un presupuesto primero." },
        { status: 422 }
      );
    }

    const result = await prisma.$transaction(
      async (tx) => {
        // Apply proyecto-level overrides if provided.
        const updates: Record<string, unknown> = {};
        if (parsed.data.viviendasObjetivo !== undefined)
          updates.viviendasObjetivo = parsed.data.viviendasObjetivo;
        if (parsed.data.weekCount !== undefined)
          updates.weekCount = parsed.data.weekCount;
        if (parsed.data.aplicaIva !== undefined)
          updates.aplicaIva = parsed.data.aplicaIva;
        if (parsed.data.fechaInicio !== undefined)
          updates.fechaInicio = parsed.data.fechaInicio
            ? new Date(parsed.data.fechaInicio)
            : null;
        if (parsed.data.fechaFinPlan !== undefined)
          updates.fechaFinPlan = parsed.data.fechaFinPlan
            ? new Date(parsed.data.fechaFinPlan)
            : null;
        if (Object.keys(updates).length > 0) {
          await tx.proyecto.update({ where: { id }, data: updates });
        }

        // Wipe existing template (cascades to partidas + curvas)
        await tx.estimacionTemplate.deleteMany({ where: { proyectoId: id } });

        // Re-bootstrap
        const finalWeekCount =
          parsed.data.weekCount ?? proyecto.weekCount ?? CURVA_DEFAULT_WEEK_COUNT;
        const r = await bootstrapEstimacionTemplate(tx, {
          proyectoId: id,
          companyId: proyecto.companyId,
          presupuestoId: presupuesto.id,
          weekCount: finalWeekCount,
        });
        return r;
      },
      { timeout: 60_000, maxWait: 5_000 }
    );

    return NextResponse.json(result);
  }
);

export const DELETE = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const proyecto = await prisma.proyecto.findUnique({
      where: { id },
      select: { id: true, companyId: true },
    });
    if (!proyecto) throw new AuthzError(404, "Proyecto no encontrado");
    await requireWriter(proyecto.companyId, req);
    await requireModule(proyecto.companyId, "CONSTRUCCION");

    const r = await prisma.estimacionTemplate.deleteMany({
      where: { proyectoId: id },
    });
    return NextResponse.json({ deleted: r.count > 0 });
  }
);
