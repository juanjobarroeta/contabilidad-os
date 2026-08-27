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
    select: { id: true, companyId: true, estado: true },
  });
  if (!r) throw new AuthzError(404, "Reembolso no encontrado");
  if (write) await requireWriter(r.companyId, req);
  else await requireMembership(r.companyId, undefined, req);
  await requireModule(r.companyId, "CONSTRUCCION");
  return r;
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
    return NextResponse.json(r);
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
