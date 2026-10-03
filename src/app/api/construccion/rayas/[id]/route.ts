/**
 * GET    /api/construccion/rayas/[id]  — raya with trabajos + detalles
 * PUT    /api/construccion/rayas/[id]  — editar mientras es BORRADOR: notas,
 *        destajo (reemplaza los trabajos) y anticipos por miembro; recalcula
 *        totalDestajo, totalJornales y total.
 * DELETE /api/construccion/rayas/[id]  — only if BORRADOR (prevents audit holes)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { totalesRaya } from "@/lib/construccion/raya-calculo";
import {
  AuthzError,
  requireMembership,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

async function loadRaya(id: string, req: Request, write = false) {
  const raya = await prisma.rayaSemanal.findUnique({
    where: { id },
    select: { id: true, companyId: true, estado: true },
  });
  if (!raya) throw new AuthzError(404, "Raya no encontrada");
  if (write) await requireWriter(raya.companyId, req);
  else await requireMembership(raya.companyId, undefined, req);
  await requireModule(raya.companyId, "CONSTRUCCION");
  return raya;
}

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    await loadRaya(id, req, false);
    const raya = await prisma.rayaSemanal.findUnique({
      where: { id },
      include: {
        cuadrilla: {
          select: {
            id: true,
            nombre: true,
            especialidad: true,
            miembros: { where: { isActive: true } },
          },
        },
        trabajos: {
          include: {
            presupuestoPartida: {
              select: {
                id: true,
                codigo: true,
                concepto: { select: { codigo: true, descripcion: true } },
              },
            },
            unidadProyecto: { select: { id: true, nombre: true, codigo: true } },
          },
        },
        detalles: { include: { miembro: true } },
        bankTransaction: true,
      },
    });
    return NextResponse.json(raya);
  }
);

const round2 = (n: number) => Math.round(n * 100) / 100;

const putSchema = z.object({
  notas: z.string().max(500).nullable().optional(),
  // Reemplaza la lista completa de trabajos a destajo.
  trabajos: z
    .array(
      z.object({
        presupuestoPartidaId: z.string().min(1).nullable().optional(),
        unidadProyectoId: z.string().min(1).nullable().optional(),
        descripcion: z.string().min(1).max(300),
        cantidad: z.number().nullable().optional(),
        unidad: z.string().max(20).nullable().optional(),
        importeDestajo: z.number().nonnegative(),
      })
    )
    .optional(),
  // Anticipos/préstamos a descontar de un miembro esta semana.
  descuentos: z
    .array(z.object({ miembroId: z.string().min(1), descuento: z.number().nonnegative() }))
    .optional(),
});

export const PUT = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const raya = await loadRaya(id, req, true);
    if (raya.estado !== "BORRADOR") {
      return NextResponse.json(
        { error: `Sólo se edita una raya en BORRADOR (está ${raya.estado})` },
        { status: 422 }
      );
    }
    const parsed = putSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { notas, trabajos, descuentos } = parsed.data;

    const updated = await prisma.$transaction(async (tx) => {
      if (trabajos) {
        await tx.rayaTrabajo.deleteMany({ where: { rayaId: id } });
        if (trabajos.length) {
          await tx.rayaTrabajo.createMany({
            data: trabajos.map((t) => ({
              rayaId: id,
              presupuestoPartidaId: t.presupuestoPartidaId ?? null,
              unidadProyectoId: t.unidadProyectoId ?? null,
              descripcion: t.descripcion,
              cantidad: t.cantidad ?? null,
              unidad: t.unidad ?? null,
              importeDestajo: t.importeDestajo,
            })),
          });
        }
      }

      // Anticipos: sólo sobre jornales (detalles con horas). El bruto es
      // importe + descuento actual; el nuevo descuento se topa a ese bruto
      // (el pago no queda negativo).
      if (descuentos?.length) {
        const detalles = await tx.rayaDetalleMiembro.findMany({
          where: {
            rayaId: id,
            miembroId: { in: descuentos.map((d) => d.miembroId) },
            OR: [{ horas: { gt: 0 } }, { horasExtra: { gt: 0 } }],
          },
          select: { id: true, miembroId: true, importe: true, descuento: true },
        });
        for (const d of detalles) {
          const pedido = descuentos.find((x) => x.miembroId === d.miembroId)!.descuento;
          const bruto = round2(Number(d.importe) + Number(d.descuento));
          const desc = round2(Math.min(pedido, bruto));
          await tx.rayaDetalleMiembro.update({
            where: { id: d.id },
            data: { descuento: desc, importe: round2(bruto - desc) },
          });
        }
      }

      const r = await tx.rayaSemanal.findUnique({
        where: { id },
        select: {
          trabajos: { select: { importeDestajo: true } },
          detalles: { select: { importe: true, horas: true, horasExtra: true } },
        },
      });
      const totalDestajo = round2(
        (r?.trabajos ?? []).reduce((a, t) => a + Number(t.importeDestajo), 0)
      );
      // Sólo los detalles con horas son jornales (salen de la asistencia) y
      // suman como pago. Los de rayas anteriores, sin horas, eran el reparto
      // del destajo: ya están dentro de totalDestajo y no se suman aparte.
      const { totalJornales, total } = totalesRaya(
        (r?.detalles ?? [])
          .filter((d) => Number(d.horas) > 0 || Number(d.horasExtra) > 0)
          .map((d) => Number(d.importe)),
        totalDestajo
      );

      return tx.rayaSemanal.update({
        where: { id },
        data: {
          ...(notas !== undefined ? { notas } : {}),
          totalDestajo,
          totalJornales,
          total,
        },
        include: {
          trabajos: true,
          detalles: { include: { miembro: true } },
          cuadrilla: { select: { id: true, nombre: true, especialidad: true } },
        },
      });
    });
    return NextResponse.json(updated);
  }
);

export const DELETE = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const raya = await loadRaya(id, req, true);
    if (raya.estado !== "BORRADOR") {
      return NextResponse.json(
        { error: `No se puede eliminar una raya ${raya.estado}` },
        { status: 422 }
      );
    }
    await prisma.rayaSemanal.delete({ where: { id } });
    return NextResponse.json({ deleted: id });
  }
);
