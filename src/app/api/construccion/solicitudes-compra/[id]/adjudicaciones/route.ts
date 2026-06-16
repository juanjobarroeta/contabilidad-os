/**
 * PUT /api/construccion/solicitudes-compra/[id]/adjudicaciones
 *
 * Adjudicación por concepto: reemplaza el mapa completo de
 * partida → cotización ganadora para una requisición. La UI envía el mapa
 * deseado entero en cada cambio (replace idempotente); una partida ausente
 * del mapa queda sin adjudicar (cotizacionGanadoraId = null).
 *
 * Body: { "adjudicaciones": { "<solicitudPartidaId>": "<cotizacionId>", ... } }
 *
 * Por cada entrada valida que la partida pertenezca a esta solicitud y que la
 * cotización pertenezca a esta solicitud y haya cotizado esa partida (existe
 * un SolicitudCotizacionPartida con ese solicitudPartidaId) — 422 si no.
 * Copia el precioUnitario de la cotización ganadora a la línea y recomputa el
 * total de la solicitud (Σ importe). El supplier de cabecera sólo se fija
 * cuando todas las líneas adjudicadas apuntan al mismo proveedor; si no, queda
 * null (adjudicación multi-proveedor). Responde con la solicitud refrescada,
 * misma forma que GET /solicitudes-compra/:id.
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

const putSchema = z.object({
  adjudicaciones: z.record(z.string().min(1), z.string().min(1)).default({}),
});

export const PUT = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const sol = await prisma.solicitudCompra.findUnique({
      where: { id },
      select: {
        id: true,
        companyId: true,
        partidas: { select: { id: true, cantidad: true } },
        cotizaciones: {
          select: {
            id: true,
            supplierId: true,
            partidas: { select: { solicitudPartidaId: true, precioUnitario: true } },
          },
        },
      },
    });
    if (!sol) throw new AuthzError(404, "Solicitud no encontrada");
    await requireWriter(sol.companyId, req);
    await requireModule(sol.companyId, "CONSTRUCCION");

    const body = await req.json().catch(() => ({}));
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const map = parsed.data.adjudicaciones;

    const partidaIds = new Set(sol.partidas.map((p) => p.id));
    const cotById = new Map(sol.cotizaciones.map((c) => [c.id, c]));

    // Validate every entry before writing anything.
    for (const [partidaId, cotizacionId] of Object.entries(map)) {
      if (!partidaIds.has(partidaId)) {
        return NextResponse.json(
          { error: `La partida ${partidaId} no pertenece a esta solicitud` },
          { status: 422 }
        );
      }
      const cot = cotById.get(cotizacionId);
      if (!cot) {
        return NextResponse.json(
          { error: `La cotización ${cotizacionId} no pertenece a esta solicitud` },
          { status: 422 }
        );
      }
      const quotedLine = cot.partidas.find((cp) => cp.solicitudPartidaId === partidaId);
      if (!quotedLine) {
        return NextResponse.json(
          { error: `La cotización ${cotizacionId} no cotizó la partida ${partidaId}` },
          { status: 422 }
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      for (const sp of sol.partidas) {
        const cotizacionId = map[sp.id];
        if (cotizacionId) {
          const cot = cotById.get(cotizacionId)!;
          const quotedLine = cot.partidas.find(
            (cp) => cp.solicitudPartidaId === sp.id
          )!;
          await tx.solicitudPartida.update({
            where: { id: sp.id },
            data: {
              cotizacionGanadoraId: cotizacionId,
              precioUnitario: quotedLine.precioUnitario,
              importe: round2(sp.cantidad * quotedLine.precioUnitario),
            },
          });
        } else {
          // Not in the map → clear any prior award.
          await tx.solicitudPartida.update({
            where: { id: sp.id },
            data: { cotizacionGanadoraId: null },
          });
        }
      }

      // Header supplier only when every awarded line points at the same
      // supplier; otherwise it's a multi-supplier award → leave null.
      const awardedSupplierIds = new Set(
        Object.values(map)
          .map((cotId) => cotById.get(cotId)?.supplierId)
          .filter((s): s is string => !!s)
      );
      const headerSupplierId =
        Object.keys(map).length > 0 && awardedSupplierIds.size === 1
          ? [...awardedSupplierIds][0]
          : null;

      const agg = await tx.solicitudPartida.aggregate({
        where: { solicitudId: id },
        _sum: { importe: true },
      });
      await tx.solicitudCompra.update({
        where: { id },
        data: {
          total: round2(agg._sum.importe ?? 0),
          supplierId: headerSupplierId,
        },
      });
    });

    const refreshed = await prisma.solicitudCompra.findUnique({
      where: { id },
      include: {
        proyecto: { select: { id: true, codigo: true, nombre: true } },
        supplier: { select: { id: true, razonSocial: true, rfc: true } },
        partidas: {
          include: {
            insumo: {
              select: { id: true, codigo: true, descripcion: true, unidad: true, costoActual: true },
            },
            presupuestoPartida: { select: { id: true, codigo: true } },
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
      },
    });

    return NextResponse.json(refreshed);
  }
);
