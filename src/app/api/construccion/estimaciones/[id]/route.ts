/**
 * GET    /api/construccion/estimaciones/[id]
 * PATCH  /api/construccion/estimaciones/[id]
 * DELETE /api/construccion/estimaciones/[id]
 *
 * Detalle, edición y borrado. Soporta DOS modos:
 *
 *   • LEAF MODE (Bartiz original): body con partidas keyed por
 *     presupuestoPartidaId + cantidadEjecutada. Wipe-and-recreate.
 *
 *   • TEMPLATE MODE (Decolsa, Run 2B): body con partidas keyed por
 *     EstimacionPartida.id + viviendasAvancePeriodo. Update in-place.
 *     Recomputa pct + importe por partida y subtotal/iva/total/importeAcum
 *     a nivel estimación.
 *
 * También permite editar el header (periodoInicio, periodoFin, fechaCorte).
 *
 * Solo en estado BORRADOR. Aprobada / timbrada / pagada → 422.
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

const round2 = (n: number) => Math.round(n * 100) / 100;

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const estimacion = await prisma.estimacion.findUnique({
      where: { id },
      include: {
        proyecto: {
          select: {
            id: true,
            codigo: true,
            nombre: true,
            companyId: true,
            viviendasObjetivo: true,
            aplicaIva: true,
            montoContratado: true,
            anticipoMonto: true,
            anticipoAmortizado: true,
            retencionPorc: true,
          },
        },
        presupuesto: { select: { id: true, nombre: true, montoTotal: true } },
        partidas: {
          // Order: template-mode rows by template.orden, leaf-mode by partida.orden
          orderBy: [{ template: { orden: "asc" } }, { presupuestoPartida: { orden: "asc" } }],
          include: {
            template: {
              select: {
                id: true,
                orden: true,
                descripcion: true,
                capituloCode: true,
                viviendasObjetivo: true,
                presupuestoPartida: {
                  select: { codigo: true, partida: true, importe: true },
                },
              },
            },
            presupuestoPartida: {
              include: {
                concepto: { select: { codigo: true, descripcion: true, unidad: true } },
              },
            },
          },
        },
        invoice: {
          select: {
            id: true,
            folio: true,
            serie: true,
            fecha: true,
            total: true,
            uuid: true,
            status: true,
          },
        },
        bankTransaction: {
          select: {
            id: true,
            fecha: true,
            monto: true,
            descripcion: true,
            referencia: true,
          },
        },
      },
    });
    if (!estimacion) throw new AuthzError(404, "Estimación no encontrada");
    await requireMembership(estimacion.companyId, undefined, req);
    await requireModule(estimacion.companyId, "CONSTRUCCION");
    return NextResponse.json(estimacion);
  }
);

// ─── PATCH body shapes ───────────────────────────────────────────────────────
// Header-only update is allowed alongside partida updates.
const headerSchema = z.object({
  periodoInicio: z.string().datetime().optional(),
  periodoFin: z.string().datetime().optional(),
  fechaCorte: z.string().datetime().optional(),
});

const leafPartidaSchema = z.object({
  presupuestoPartidaId: z.string().min(1),
  cantidadEjecutada: z.number().nonnegative(),
});

const templatePartidaSchema = z.object({
  id: z.string().min(1),
  viviendasAvancePeriodo: z.number().int().min(0),
});

const patchSchema = z.object({
  header: headerSchema.optional(),
  // Either leaf-mode or template-mode partidas; arrays are differentiated by
  // their first key. Both can be empty/absent for header-only updates.
  partidas: z
    .union([z.array(leafPartidaSchema), z.array(templatePartidaSchema)])
    .optional(),
});

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const estimacion = await prisma.estimacion.findUnique({
      where: { id },
      select: {
        id: true,
        companyId: true,
        estado: true,
        proyectoId: true,
        presupuestoId: true,
        numero: true,
      },
    });
    if (!estimacion) throw new AuthzError(404, "Estimación no encontrada");
    await requireWriter(estimacion.companyId, req);
    await requireModule(estimacion.companyId, "CONSTRUCCION");

    if (estimacion.estado !== "BORRADOR") {
      return NextResponse.json(
        { error: `No se puede editar (estado: ${estimacion.estado})` },
        { status: 422 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      );
    }

    await prisma.$transaction(async (tx) => {
      if (parsed.data.header) {
        const hdr = parsed.data.header;
        await tx.estimacion.update({
          where: { id },
          data: {
            ...(hdr.periodoInicio && { periodoInicio: new Date(hdr.periodoInicio) }),
            ...(hdr.periodoFin && { periodoFin: new Date(hdr.periodoFin) }),
            ...(hdr.fechaCorte && { fechaCorte: new Date(hdr.fechaCorte) }),
          },
        });
      }

      if (parsed.data.partidas && parsed.data.partidas.length > 0) {
        const first = parsed.data.partidas[0];
        const isTemplate = "id" in first;

        if (isTemplate) {
          // ── TEMPLATE MODE (Decolsa) ──────────────────────────────────────
          const updates = new Map<string, number>();
          for (const p of parsed.data.partidas as z.infer<typeof templatePartidaSchema>[]) {
            updates.set(p.id, p.viviendasAvancePeriodo);
          }
          const current = await tx.estimacionPartida.findMany({
            where: { estimacionId: id, id: { in: [...updates.keys()] } },
            select: {
              id: true,
              viviendasAvanceAnterior: true,
              viviendasObjetivo: true,
              importeContrato: true,
            },
          });
          for (const p of current) {
            const newPeriodo = updates.get(p.id)!;
            const obj = p.viviendasObjetivo ?? 1;
            const anterior = p.viviendasAvanceAnterior ?? 0;
            const acumulado = Math.min(anterior + newPeriodo, obj);
            const cappedPeriodo = acumulado - anterior;
            const importeC = Number(p.importeContrato ?? 0);
            const pctAcum = obj > 0 ? acumulado / obj : 0;
            const pctPer = obj > 0 ? cappedPeriodo / obj : 0;
            const importePer = round2(importeC * pctPer);
            await tx.estimacionPartida.update({
              where: { id: p.id },
              data: {
                viviendasAvancePeriodo: cappedPeriodo,
                viviendasAvanceAcumulado: acumulado,
                pctPeriodo: pctPer,
                pctAcumulado: pctAcum,
                importe: importePer,
              },
            });
          }
        } else {
          // ── LEAF MODE (Bartiz original) ──────────────────────────────────
          // Wipe + recreate behavior preserved.
          await tx.estimacionPartida.deleteMany({ where: { estimacionId: id } });
          for (const p of parsed.data.partidas as z.infer<typeof leafPartidaSchema>[]) {
            if (p.cantidadEjecutada <= 0) continue;
            const pp = await tx.presupuestoPartida.findUnique({
              where: { id: p.presupuestoPartidaId },
              select: { id: true, presupuestoId: true, precioUnitario: true },
            });
            if (!pp || pp.presupuestoId !== estimacion.presupuestoId) continue;
            const priorAgg = await tx.estimacionPartida.aggregate({
              where: {
                presupuestoPartidaId: p.presupuestoPartidaId,
                estimacion: { proyectoId: estimacion.proyectoId, id: { not: id } },
              },
              _sum: { cantidadEjecutada: true },
            });
            const priorExecuted = Number(priorAgg._sum.cantidadEjecutada ?? 0);
            const cantidadAcumulada = round2(priorExecuted + p.cantidadEjecutada);
            const importe = round2(p.cantidadEjecutada * Number(pp.precioUnitario));
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
        }
      }

      // ── Recompute estimación-level totals ──────────────────────────────
      const allPartidas = (
        await tx.estimacionPartida.findMany({
          where: { estimacionId: id },
          select: {
            importe: true,
            pctAcumulado: true,
            importeContrato: true,
          },
        })
      ).map((p) => ({
        ...p,
        importe: Number(p.importe),
        importeContrato: p.importeContrato === null ? null : Number(p.importeContrato),
      }));
      const subtotal = round2(
        allPartidas.reduce((a, p) => a + (p.importe ?? 0), 0)
      );
      const importeContratoTotal = allPartidas.reduce(
        (a, p) => a + (p.importeContrato ?? 0),
        0
      );
      const importeAcumPartidas = round2(
        allPartidas.reduce(
          (a, p) => a + (p.importeContrato ?? 0) * (p.pctAcumulado ?? 0),
          0
        )
      );
      const proy = await tx.estimacion.findUnique({
        where: { id },
        select: { proyecto: { select: { aplicaIva: true } } },
      });
      const aplicaIva = proy?.proyecto?.aplicaIva ?? false;
      const iva = aplicaIva ? round2(subtotal * 0.16) : 0;
      const total = round2(subtotal + iva);
      const pctPeriodo =
        importeContratoTotal > 0 ? subtotal / importeContratoTotal : 0;
      const pctAcumulado =
        importeContratoTotal > 0
          ? importeAcumPartidas / importeContratoTotal
          : 0;

      await tx.estimacion.update({
        where: { id },
        data: {
          subtotal,
          iva,
          total,
          importeAcumulado: importeAcumPartidas,
          pctPeriodo,
          pctAcumulado,
        },
      });
    });

    const updated = await prisma.estimacion.findUnique({
      where: { id },
      include: {
        partidas: {
          orderBy: [
            { template: { orden: "asc" } },
            { presupuestoPartida: { orden: "asc" } },
          ],
        },
      },
    });
    return NextResponse.json(updated);
  }
);

export const DELETE = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const estimacion = await prisma.estimacion.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true },
    });
    if (!estimacion) throw new AuthzError(404, "Estimación no encontrada");
    await requireWriter(estimacion.companyId, req);
    await requireModule(estimacion.companyId, "CONSTRUCCION");

    if (estimacion.estado !== "BORRADOR") {
      return NextResponse.json(
        { error: "Solo se pueden eliminar estimaciones en BORRADOR." },
        { status: 422 }
      );
    }
    await prisma.estimacion.delete({ where: { id } });
    return NextResponse.json({ deleted: id });
  }
);
