/**
 * GET /api/construccion/solicitudes-compra/[id]
 *   Full requisición detail: header + partidas + all cotizaciones with
 *   their per-line pricing. Drives the multi-vendor matrix UI in bartiz.
 *
 * PUT /api/construccion/solicitudes-compra/[id]
 *   Rebuild a BORRADOR (draft): replaces header + partidas + offers from a
 *   single payload, and can flip estado to PENDIENTE ("enviar a autorización").
 *   Only borradores are editable this way — once submitted, a requisición is
 *   edited through its quote/award endpoints, not wholesale.
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
import { buildPartidasAndOffers } from "@/lib/construccion/requisicion-offers";

const putSchema = z.object({
  folio: z.string().min(1).optional(),
  proyectoId: z.string().nullable().optional(),
  notas: z.string().nullable().optional(),
  fechaEntrega: z.string().nullable().optional(),
  formaPago: z.enum(["CREDITO", "CONTADO"]).nullable().optional(),
  estado: z.enum(["BORRADOR", "PENDIENTE"]).optional(),
  partidas: z
    .array(
      z.object({
        insumoId: z.string().optional(),
        descripcion: z.string().min(1),
        unidad: z.string().max(20).nullable().optional(),
        cantidad: z.number().positive(),
        precioUnitario: z.number().nonnegative().optional(),
        presupuestoPartidaId: z.string().optional(),
      })
    )
    .min(1),
  offers: z
    .array(
      z.object({
        supplierId: z.string().min(1).nullable().optional(),
        supplierNombre: z.string().min(1).max(120),
        tieneCredito: z.boolean().optional(),
        diasEntrega: z.number().int().min(0).max(365).nullable().optional(),
        lineas: z
          .array(
            z.object({
              partidaIndex: z.number().int().nonnegative(),
              precioUnitario: z.number().nonnegative(),
            })
          )
          .default([]),
      })
    )
    .optional(),
});

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const sol = await prisma.solicitudCompra.findUnique({
      where: { id },
      include: {
        proyecto: { select: { id: true, codigo: true, nombre: true } },
        supplier: { select: { id: true, razonSocial: true, rfc: true } },
        partidas: {
          include: {
            insumo: {
              select: { id: true, codigo: true, descripcion: true, unidad: true, costoActual: true },
            },
            presupuestoPartida: {
              select: { id: true, codigo: true },
            },
          },
        },
        cotizaciones: {
          include: {
            supplier: { select: { id: true, razonSocial: true, rfc: true } },
            partidas: true,
          },
          orderBy: { fechaCotizacion: "desc" },
        },
        bankTransaction: {
          select: {
            id: true,
            fecha: true,
            monto: true,
            descripcion: true,
            referencia: true,
            status: true,
            bankAccount: { select: { banco: true, nombre: true } },
          },
        },
        adjudicaciones: {
          include: {
            bankTransaction: {
              select: { id: true, fecha: true, monto: true, referencia: true, bankAccount: { select: { banco: true, nombre: true } } },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!sol) throw new AuthzError(404, "Solicitud no encontrada");
    await requireMembership(sol.companyId, undefined, req);
    await requireModule(sol.companyId, "CONSTRUCCION");
    return NextResponse.json(sol);
  }
);

export const PUT = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const existing = await prisma.solicitudCompra.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true },
    });
    if (!existing) throw new AuthzError(404, "Solicitud no encontrada");
    await requireWriter(existing.companyId, req);
    await requireModule(existing.companyId, "CONSTRUCCION");

    // Only drafts can be rebuilt wholesale — a submitted requisición may have
    // approvals / payments / awards we must not silently drop.
    if (existing.estado !== "BORRADOR") {
      return NextResponse.json(
        { error: "Solo se pueden editar borradores. Esta requisición ya fue enviada." },
        { status: 409 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const data = parsed.data;

    if (data.proyectoId) {
      const p = await prisma.proyecto.findUnique({
        where: { id: data.proyectoId },
        select: { companyId: true },
      });
      if (!p || p.companyId !== existing.companyId) {
        return NextResponse.json({ error: "Proyecto inválido" }, { status: 400 });
      }
    }

    try {
      const updated = await prisma.$transaction(async (tx) => {
        // Wipe and rebuild lines + offers. Cotizaciones first (cascades their
        // line items and nulls any award), then partidas.
        await tx.solicitudCompraCotizacion.deleteMany({ where: { solicitudId: id } });
        await tx.solicitudPartida.deleteMany({ where: { solicitudId: id } });

        const { total } = await buildPartidasAndOffers(tx, id, data.partidas, data.offers ?? []);

        await tx.solicitudCompra.update({
          where: { id },
          data: {
            ...(data.folio !== undefined && { folio: data.folio }),
            ...(data.proyectoId !== undefined && { proyectoId: data.proyectoId }),
            ...(data.notas !== undefined && { notas: data.notas }),
            ...(data.fechaEntrega !== undefined && {
              fechaEntrega: data.fechaEntrega ? new Date(data.fechaEntrega) : null,
            }),
            ...(data.formaPago !== undefined && { formaPago: data.formaPago }),
            ...(data.estado !== undefined && { estado: data.estado }),
            total,
          },
        });

        return tx.solicitudCompra.findUnique({
          where: { id },
          include: { partidas: true, cotizaciones: { include: { partidas: true } } },
        });
      });
      return NextResponse.json(updated);
    } catch (e: unknown) {
      if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") {
        return NextResponse.json(
          { error: "Ya existe una solicitud con ese folio" },
          { status: 409 }
        );
      }
      throw e;
    }
  }
);

// DELETE — discard a draft. Only borradores can be deleted; a submitted
// requisición is kept (cancel it through the normal flow instead).
export const DELETE = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const existing = await prisma.solicitudCompra.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true },
    });
    if (!existing) throw new AuthzError(404, "Solicitud no encontrada");
    await requireWriter(existing.companyId, req);
    await requireModule(existing.companyId, "CONSTRUCCION");

    if (existing.estado !== "BORRADOR") {
      return NextResponse.json(
        { error: "Solo se pueden eliminar borradores." },
        { status: 409 }
      );
    }

    // Cotizaciones cascade their line items; partidas cascade with the
    // solicitud (onDelete: Cascade on the partida→solicitud relation).
    await prisma.solicitudCompra.delete({ where: { id } });
    return NextResponse.json({ deleted: id });
  }
);
