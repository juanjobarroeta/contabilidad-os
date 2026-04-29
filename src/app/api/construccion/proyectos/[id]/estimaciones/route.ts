/**
 * GET  /api/construccion/proyectos/[id]/estimaciones
 *      → lista todas las estimaciones del proyecto (orden DESC por número)
 *
 * POST /api/construccion/proyectos/[id]/estimaciones
 *      → crea la estimación N+1 clonando la plantilla y arrastrando los
 *        viviendasAvanceAnterior desde la estimación anterior aprobada.
 *
 * Body POST: { periodoInicio: string, periodoFin: string, fechaCorte?: string }
 *
 * Response POST: la estimación recién creada con sus partidas.
 *
 * Reglas:
 *   • Tiene que existir EstimacionTemplate sino 422.
 *   • numero auto-incrementa (max(numero) + 1, 1 si no hay).
 *   • Se carry-forward viviendasAvanceAcumulado desde la última estimación
 *     APROBADA (o la previa BORRADOR si no hay aprobadas) → así Gerardo
 *     puede tener una en BORRADOR mientras edita.
 *   • Snapshot de descripcion + importeContrato del template a cada partida
 *     para que ediciones futuras del template no muevan estimaciones viejas.
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

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const proyecto = await prisma.proyecto.findUnique({
      where: { id },
      select: { id: true, companyId: true },
    });
    if (!proyecto) throw new AuthzError(404, "Proyecto no encontrado");
    await requireMembership(proyecto.companyId, undefined, req);
    await requireModule(proyecto.companyId, "CONSTRUCCION");

    const estimaciones = await prisma.estimacion.findMany({
      where: { proyectoId: id },
      orderBy: { numero: "desc" },
      select: {
        id: true,
        numero: true,
        periodoInicio: true,
        periodoFin: true,
        fechaCorte: true,
        estado: true,
        subtotal: true,
        iva: true,
        total: true,
        importeAcumulado: true,
        pctPeriodo: true,
        pctAcumulado: true,
        invoiceId: true,
        bankTransactionId: true,
        invoice: {
          select: { folio: true, serie: true, fecha: true, total: true, uuid: true },
        },
        bankTransaction: {
          select: { fecha: true, monto: true, descripcion: true },
        },
      },
    });

    return NextResponse.json(estimaciones);
  }
);

const createSchema = z.object({
  periodoInicio: z.string().datetime(),
  periodoFin: z.string().datetime(),
  fechaCorte: z.string().datetime().optional(),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const proyecto = await prisma.proyecto.findUnique({
      where: { id },
      select: { id: true, companyId: true, viviendasObjetivo: true, aplicaIva: true },
    });
    if (!proyecto) throw new AuthzError(404, "Proyecto no encontrado");
    await requireWriter(proyecto.companyId, req);
    await requireModule(proyecto.companyId, "CONSTRUCCION");

    const body = await req.json().catch(() => ({}));
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const template = await prisma.estimacionTemplate.findUnique({
      where: { proyectoId: id },
      include: {
        partidas: {
          orderBy: { orden: "asc" },
          include: {
            presupuestoPartida: {
              select: { id: true, importe: true, partida: true },
            },
          },
        },
      },
    });
    if (!template) {
      return NextResponse.json(
        { error: "El proyecto no tiene plantilla de estimaciones. Crea una primero." },
        { status: 422 }
      );
    }

    const presupuesto = await prisma.presupuesto.findFirst({
      where: { proyectoId: id },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!presupuesto) {
      return NextResponse.json(
        { error: "El proyecto no tiene presupuesto." },
        { status: 422 }
      );
    }

    // Compute next numero
    const last = await prisma.estimacion.findFirst({
      where: { proyectoId: id },
      orderBy: { numero: "desc" },
      select: {
        id: true,
        numero: true,
        partidas: {
          select: {
            templatePartidaId: true,
            viviendasAvanceAcumulado: true,
          },
        },
      },
    });
    const numero = (last?.numero ?? 0) + 1;

    // Pull carry-forward map from previous estimación
    const carryForward = new Map<string, number>();
    if (last) {
      for (const p of last.partidas) {
        if (p.templatePartidaId && p.viviendasAvanceAcumulado != null) {
          carryForward.set(p.templatePartidaId, p.viviendasAvanceAcumulado);
        }
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const estimacion = await tx.estimacion.create({
        data: {
          companyId: proyecto.companyId,
          proyectoId: id,
          presupuestoId: presupuesto.id,
          numero,
          periodoInicio: new Date(parsed.data.periodoInicio),
          periodoFin: new Date(parsed.data.periodoFin),
          fechaCorte: parsed.data.fechaCorte
            ? new Date(parsed.data.fechaCorte)
            : new Date(parsed.data.periodoFin),
          estado: "BORRADOR",
          subtotal: 0,
          iva: 0,
          total: 0,
          importeAcumulado: 0,
          pctPeriodo: 0,
          pctAcumulado: 0,
        },
      });

      // Snapshot rows for each template partida
      const rows = template.partidas.map((tp) => ({
        estimacionId: estimacion.id,
        templatePartidaId: tp.id,
        descripcionSnapshot: tp.descripcion,
        importeContrato: tp.presupuestoPartida.importe ?? 0,
        viviendasObjetivo:
          tp.viviendasObjetivo ?? proyecto.viviendasObjetivo ?? 1,
        viviendasAvanceAnterior: carryForward.get(tp.id) ?? 0,
        viviendasAvancePeriodo: 0,
        viviendasAvanceAcumulado: carryForward.get(tp.id) ?? 0,
        pctPeriodo: 0,
        pctAcumulado:
          (carryForward.get(tp.id) ?? 0) /
          Math.max(tp.viviendasObjetivo ?? proyecto.viviendasObjetivo ?? 1, 1),
        importe: 0,
      }));
      if (rows.length > 0) {
        await tx.estimacionPartida.createMany({ data: rows });
      }
      return estimacion;
    });

    return NextResponse.json(result, { status: 201 });
  }
);
