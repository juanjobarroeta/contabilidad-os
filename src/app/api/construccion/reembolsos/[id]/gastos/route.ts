/**
 * POST   /api/construccion/reembolsos/[id]/gastos  — attach / create a gasto
 *                                                    inside this reembolso
 *
 * Two modes in the body:
 *   { gastoId: "..." }                  → attach an existing gasto
 *   { beneficiarioNombre, descripcion,
 *     importe, cantidad?, unidad?,
 *     presupuestoPartidaId? | insumoId?,
 *     indirecto?, categoriaIndirecto? } → create a new gasto directly
 *                                         inside this reembolso
 *
 * The new-gasto path is the common one — Katia is going through Rosy's
 * package line by line and inlining the gastos. Reuses the same POST
 * logic as /gastos (attribution validation etc.) but with reembolsoId
 * pre-set and bankAccountId defaulting to the reembolso's account.
 *
 * On every write, recompute the reembolso's totalGastos + totalReembolso.
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

const attachSchema = z.object({
  gastoId: z.string().min(1),
});

const createSchema = z.object({
  beneficiarioNombre: z.string().min(1).max(200),
  descripcion: z.string().min(1).max(500),
  importe: z.number().positive(),
  // Proveedor etiquetado (opcional): habilita sugerir CFDIs por RFC para
  // conciliar el gasto y volverlo deducible.
  supplierId: z.string().min(1).nullable().optional(),
  cantidad: z.number().positive().nullable().optional(),
  unidad: z.string().max(20).nullable().optional(),
  bankAccountId: z.string().min(1).nullable().optional(), // defaults to reembolso's
  presupuestoPartidaId: z.string().min(1).nullable().optional(),
  insumoId: z.string().min(1).nullable().optional(),
  comprobanteUrl: z.string().max(1000).nullable().optional(),
  comprobanteData: z.string().nullable().optional(),
  comprobanteMime: z.string().max(80).nullable().optional(),
  comprobanteName: z.string().max(200).nullable().optional(),
  notas: z.string().max(1000).nullable().optional(),
  indirecto: z.boolean().optional(),
  categoriaIndirecto: z.string().max(40).nullable().optional(),
});

async function recomputeTotals(reembolsoId: string) {
  const agg = await prisma.gasto.aggregate({
    where: { reembolsoId, estado: { not: "RECHAZADO" } },
    _sum: { importe: true },
  });
  const totalGastos = Math.round(Number(agg._sum.importe ?? 0) * 100) / 100;
  const current = await prisma.reembolsoSemanal.findUnique({
    where: { id: reembolsoId },
    select: { anticipoAplicado: true },
  });
  const totalReembolso =
    Math.round((totalGastos - Number(current?.anticipoAplicado ?? 0)) * 100) / 100;
  await prisma.reembolsoSemanal.update({
    where: { id: reembolsoId },
    data: { totalGastos, totalReembolso },
  });
}

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const reembolso = await prisma.reembolsoSemanal.findUnique({
      where: { id },
      select: {
        id: true,
        companyId: true,
        proyectoId: true,
        bankAccountId: true,
        estado: true,
        creadaPorId: true,
      },
    });
    if (!reembolso) throw new AuthzError(404, "Reembolso no encontrado");
    const { user, membership } = await requireWriter(reembolso.companyId, req);
    await requireModule(reembolso.companyId, "CONSTRUCCION");
    // Cada caja tiene dueño: sólo él (y OWNER/ADMIN) le suben gastos. Filas
    // históricas sin dueño quedan sólo-admin.
    const esAdmin = membership.role === "OWNER" || membership.role === "ADMIN";
    if (!esAdmin && reembolso.creadaPorId !== user.id) {
      throw new AuthzError(403, "Esta caja chica es de otro usuario; sólo su responsable o un admin le agregan gastos");
    }
    if (reembolso.estado === "REEMBOLSADO") {
      return NextResponse.json(
        { error: "Reembolso ya pagado; no se pueden agregar gastos" },
        { status: 422 }
      );
    }

    const body = await req.json().catch(() => ({}));

    // Attach existing gasto flow
    if (body.gastoId) {
      const parsed = attachSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
      }
      const existing = await prisma.gasto.findUnique({
        where: { id: parsed.data.gastoId },
        select: { id: true, companyId: true, reembolsoId: true, estado: true },
      });
      if (!existing || existing.companyId !== reembolso.companyId) {
        return NextResponse.json({ error: "Gasto inválido" }, { status: 400 });
      }
      if (existing.estado === "PAGADO") {
        return NextResponse.json(
          { error: "El gasto ya fue pagado y no se puede reasignar" },
          { status: 422 }
        );
      }
      await prisma.gasto.update({
        where: { id: existing.id },
        data: { reembolsoId: id },
      });
      await recomputeTotals(id);
      return NextResponse.json({ attached: existing.id });
    }

    // Create new gasto flow
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const data = parsed.data;

    // Attribution invariant (same as /gastos POST)
    const isDirecto = !!(data.presupuestoPartidaId || data.insumoId);
    const isIndirecto = data.indirecto === true && !!data.categoriaIndirecto;
    if (!isDirecto && !isIndirecto) {
      return NextResponse.json(
        {
          error:
            "Gasto sin atribución: vincula a insumo/partida o marca indirecto con categoría.",
        },
        { status: 422 }
      );
    }

    const bankAccountId = data.bankAccountId ?? reembolso.bankAccountId;

    // Proveedor etiquetado (opcional): debe ser de la misma empresa.
    if (data.supplierId) {
      const sup = await prisma.supplier.findUnique({
        where: { id: data.supplierId },
        select: { companyId: true },
      });
      if (!sup || sup.companyId !== reembolso.companyId) {
        return NextResponse.json({ error: "supplierId inválido" }, { status: 400 });
      }
    }

    const created = await prisma.gasto.create({
      data: {
        companyId: reembolso.companyId,
        proyectoId: reembolso.proyectoId,
        bankAccountId,
        reembolsoId: id,
        creadaPorId: user.id,
        supplierId: data.supplierId ?? null,
        beneficiarioNombre: data.beneficiarioNombre,
        descripcion: data.descripcion,
        importe: data.importe,
        cantidad: data.cantidad ?? null,
        unidad: data.unidad ?? null,
        presupuestoPartidaId: isDirecto ? data.presupuestoPartidaId ?? null : null,
        insumoId: isDirecto ? data.insumoId ?? null : null,
        indirecto: isIndirecto,
        categoriaIndirecto: isIndirecto ? data.categoriaIndirecto ?? null : null,
        comprobanteUrl: data.comprobanteUrl ?? null,
        comprobanteData: data.comprobanteData ?? null,
        comprobanteMime: data.comprobanteMime ?? null,
        comprobanteName: data.comprobanteName ?? null,
        notas: data.notas ?? null,
      },
      include: {
        presupuestoPartida: {
          select: {
            id: true,
            codigo: true,
            concepto: { select: { codigo: true, descripcion: true } },
          },
        },
        insumo: {
          select: { id: true, codigo: true, descripcion: true, unidad: true, costoActual: true },
        },
      },
    });
    await recomputeTotals(id);
    return NextResponse.json(created, { status: 201 });
  }
);
