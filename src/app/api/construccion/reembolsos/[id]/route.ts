/**
 * GET    /api/construccion/reembolsos/[id]  — header + all gastos joined
 * PATCH  /api/construccion/reembolsos/[id]  — edit header fields (while not paid)
 * DELETE /api/construccion/reembolsos/[id]  — delete (only if SUBMITTED, no paid gastos)
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
  semanaInicio: z.string().optional(),
  semanaFin: z.string().optional(),
  bankAccountId: z.string().min(1).optional(),
  anticipoAplicado: z.number().nonnegative().optional(),
  notas: z.string().max(1000).nullable().optional(),
  estado: z.enum(["SUBMITTED", "REVISADO", "RECHAZADO"]).optional(),
});

async function loadReembolso(id: string, req: Request, write = false) {
  const r = await prisma.reembolsoSemanal.findUnique({
    where: { id },
    select: { id: true, companyId: true, estado: true, creadaPorId: true },
  });
  if (!r) throw new AuthzError(404, "Reembolso no encontrado");
  if (write) {
    const { user, membership } = await requireWriter(r.companyId, req);
    // Cada caja tiene dueño: sólo él (y OWNER/ADMIN) la editan. Filas
    // históricas sin dueño quedan sólo-admin, como siempre fueron.
    const esAdmin = membership.role === "OWNER" || membership.role === "ADMIN";
    if (!esAdmin && r.creadaPorId !== user.id) {
      throw new AuthzError(403, "Esta caja chica es de otro usuario; sólo su responsable o un admin pueden editarla");
    }
    await requireModule(r.companyId, "CONSTRUCCION");
    return { ...r, esAdmin };
  }
  await requireMembership(r.companyId, undefined, req);
  await requireModule(r.companyId, "CONSTRUCCION");
  return { ...r, esAdmin: false };
}

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    await loadReembolso(id, req, false);
    const r = await prisma.reembolsoSemanal.findUnique({
      where: { id },
      include: {
        proyecto: { select: { id: true, codigo: true, nombre: true } },
        bankAccount: { select: { id: true, banco: true, nombre: true, tipo: true, titular: true } },
        bankTransaction: true,
        gastos: {
          include: {
            bankAccount: { select: { id: true, banco: true, nombre: true, tipo: true } },
            presupuestoPartida: {
              select: {
                id: true,
                codigo: true,
                concepto: { select: { codigo: true, descripcion: true } },
              },
            },
            insumo: {
              select: {
                id: true,
                codigo: true,
                descripcion: true,
                unidad: true,
                costoActual: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    // Nombre del dueño (creadaPorId sin FK) para el encabezado del detalle.
    let creadaPorNombre: string | null = null;
    if (r?.creadaPorId) {
      const u = await prisma.user.findUnique({
        where: { id: r.creadaPorId },
        select: { name: true, email: true },
      });
      creadaPorNombre = u?.name || u?.email || null;
    }

    // CFDI vinculado por gasto (conciliación de caja chica → deducible):
    // un lookup por lote sobre construccion_cfdi_vinculo targetTipo GASTO.
    const gastoIds = (r?.gastos ?? []).map((g) => g.id);
    const vinculos = gastoIds.length
      ? await prisma.construccionCfdiVinculo.findMany({
          where: {
            companyId: r!.companyId,
            estado: "VINCULADA",
            targetTipo: "GASTO",
            targetId: { in: gastoIds },
          },
          select: {
            targetId: true,
            invoice: {
              select: {
                id: true,
                uuid: true,
                total: true,
                customer: { select: { razonSocial: true } },
                contraparteNombre: true,
              },
            },
          },
        })
      : [];
    const cfdiPorGasto = new Map(
      vinculos.map((v) => [
        v.targetId,
        {
          invoiceId: v.invoice.id,
          uuid: v.invoice.uuid,
          total: Number(v.invoice.total),
          emisor: v.invoice.customer?.razonSocial ?? v.invoice.contraparteNombre ?? null,
        },
      ])
    );
    return NextResponse.json({
      ...r,
      creadaPorNombre,
      gastos: (r?.gastos ?? []).map((g) => ({
        ...g,
        cfdiVinculado: cfdiPorGasto.get(g.id) ?? null,
      })),
    });
  }
);

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const r = await loadReembolso(id, req, true);
    if (r.estado === "REEMBOLSADO") {
      return NextResponse.json(
        { error: "Reembolso ya pagado; no se puede editar" },
        { status: 422 }
      );
    }
    const body = await req.json().catch(() => ({}));
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    // Las decisiones de revisión (REVISADO/RECHAZADO) son de admin: el dueño
    // restringido edita su caja pero no se auto-revisa.
    if (parsed.data.estado && !r.esAdmin) {
      return NextResponse.json(
        { error: "Sólo un admin puede cambiar el estado de revisión" },
        { status: 403 }
      );
    }

    const data: Record<string, unknown> = {};
    if (parsed.data.semanaInicio) data.semanaInicio = new Date(parsed.data.semanaInicio);
    if (parsed.data.semanaFin) data.semanaFin = new Date(parsed.data.semanaFin);
    if (parsed.data.bankAccountId) data.bankAccountId = parsed.data.bankAccountId;
    if (parsed.data.anticipoAplicado !== undefined)
      data.anticipoAplicado = parsed.data.anticipoAplicado;
    if (parsed.data.notas !== undefined) data.notas = parsed.data.notas;
    if (parsed.data.estado) data.estado = parsed.data.estado;

    // If anticipoAplicado changed, refresh totalReembolso = totalGastos - anticipo
    if (parsed.data.anticipoAplicado !== undefined) {
      const existing = await prisma.reembolsoSemanal.findUnique({
        where: { id },
        select: { totalGastos: true },
      });
      data.totalReembolso =
        Math.round((Number(existing?.totalGastos ?? 0) - parsed.data.anticipoAplicado) * 100) / 100;
    }

    const updated = await prisma.reembolsoSemanal.update({
      where: { id },
      data,
    });
    return NextResponse.json(updated);
  }
);

export const DELETE = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const r = await loadReembolso(id, req, true);
    if (r.estado !== "SUBMITTED" && r.estado !== "RECHAZADO") {
      return NextResponse.json(
        { error: `No se puede eliminar un reembolso ${r.estado}` },
        { status: 422 }
      );
    }
    // Unlink any gastos first (SetNull cascade on schema handles it, but
    // be explicit so the gasto rows survive)
    await prisma.gasto.updateMany({
      where: { reembolsoId: id },
      data: { reembolsoId: null },
    });
    await prisma.reembolsoSemanal.delete({ where: { id } });
    return NextResponse.json({ deleted: id });
  }
);
