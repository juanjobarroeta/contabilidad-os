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
import { moneyPush, notificarConstruccion } from "@/lib/construccion/push";

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
        diasCredito: z.number().int().min(0).max(365).nullable().optional(),
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
    const { user } = await requireWriter(existing.companyId, req);
    await requireModule(existing.companyId, "CONSTRUCCION");

    // Un-authorized requisiciones (BORRADOR draft + PENDIENTE awaiting
    // authorization) can be rebuilt wholesale: no adjudicaciones/payments exist
    // yet, so adding a supplier, re-pricing or editing conceptos is safe. Once
    // APROBADA/PAGADA the per-supplier adjudicaciones and payments must not be
    // silently dropped.
    if (existing.estado !== "BORRADOR" && existing.estado !== "PENDIENTE") {
      return NextResponse.json(
        { error: "Solo se pueden editar requisiciones no autorizadas (borrador o pendiente)." },
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
      // Borrador que se acaba de ENVIAR a autorización → avisar a los que
      // autorizan (el create con estado PENDIENTE ya avisa por su lado).
      if (existing.estado === "BORRADOR" && updated?.estado === "PENDIENTE") {
        void notificarConstruccion({
          companyId: existing.companyId,
          destinos: ["ADMIN", "CONTABILIDAD"],
          excludeUserId: user.id,
          payload: {
            title: `Nueva requisición ${updated.folio}`,
            body: `${moneyPush(updated.total)} — por autorizar`,
            url: "/compras-por-autorizar",
            tag: `solicitud-${updated.id}`,
          },
        });
      }
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

// DELETE — discard an un-authorized requisición (BORRADOR or PENDIENTE).
// Authorized ones (APROBADA/PAGADA) are kept: they carry adjudicaciones and
// possibly payments, and should be cancelled through the normal flow instead.
export const DELETE = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const existing = await prisma.solicitudCompra.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true },
    });
    if (!existing) throw new AuthzError(404, "Solicitud no encontrada");
    const { membership } = await requireWriter(existing.companyId, req);
    await requireModule(existing.companyId, "CONSTRUCCION");

    // Reglas de borrado por estado:
    //   BORRADOR/PENDIENTE — cualquier writer (como siempre).
    //   APROBADA           — sólo OWNER/ADMIN: arrastra sus adjudicaciones
    //                        (y aplicaciones de pago) y saca la fila de la
    //                        cola de cuentas por pagar.
    //   PAGADA             — nunca por API: es evidencia de dinero gastado
    //                        (auditoría); una limpieza deliberada va por el
    //                        script de mantenimiento.
    const esAdmin = membership.role === "OWNER" || membership.role === "ADMIN";
    if (existing.estado === "PAGADA") {
      return NextResponse.json(
        { error: "Una requisición pagada no se puede eliminar (respaldo de auditoría)." },
        { status: 409 }
      );
    }
    if (!esAdmin && existing.estado !== "BORRADOR" && existing.estado !== "PENDIENTE") {
      return NextResponse.json(
        { error: "Solo un administrador puede eliminar requisiciones ya autorizadas." },
        { status: 409 }
      );
    }

    // Orden hijo→padre para no despertar los RESTRICT del árbol (cotización↔
    // partida y adjudicación↔cotización); mismo orden que el PUT rebuild y el
    // script de limpieza. Las aplicaciones de pago caen en cascada desde la
    // adjudicación; los vínculos de CFDI se sueltan (la factura se conserva y
    // vuelve a "por vincular").
    await prisma.$transaction(async (tx) => {
      await tx.solicitudAdjudicacion.deleteMany({ where: { solicitudId: id } });
      await tx.solicitudCotizacionPartida.deleteMany({
        where: { cotizacion: { solicitudId: id } },
      });
      await tx.solicitudCompraCotizacion.deleteMany({ where: { solicitudId: id } });
      await tx.construccionCfdiVinculo.deleteMany({
        where: { companyId: existing.companyId, targetTipo: "SOLICITUD", targetId: id },
      });
      await tx.solicitudCompra.delete({ where: { id } });
    });
    return NextResponse.json({ deleted: id });
  }
);
