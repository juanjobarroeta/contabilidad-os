/**
 * GET /api/construccion/gastos/[id]/cfdi-candidatos
 *
 * CFDIs recibidos (EGRESO) que probablemente amparan este gasto, para
 * conciliarlo desde caja chica y volverlo deducible. Ranking barato:
 *   +100 RFC del proveedor etiquetado en el gasto = RFC emisor del CFDI
 *   +80…0 cercanía de monto (total vs importe; exacto = 80)
 *   +20…0 cercanía de fecha (±45 días alrededor del gasto)
 * Sólo CFDIs sin vincular (sin ConstruccionCfdiVinculo VINCULADA/IGNORADA).
 *
 * Devuelve { vinculado, candidatos } — `vinculado` es el CFDI ya ligado a
 * este gasto (targetTipo GASTO), para que la UI enseñe el estado real.
 * El link se confirma con el endpoint existente POST /cfdis/[id]/vincular
 * { tipo: "GASTO", targetId }.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, withAuthz } from "@/lib/authz";

const DIAS_VENTANA = 45;

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const gasto = await prisma.gasto.findUnique({
      where: { id },
      select: {
        id: true,
        companyId: true,
        importe: true,
        createdAt: true,
        pagadoAt: true,
        beneficiarioNombre: true,
        supplier: { select: { rfc: true, razonSocial: true } },
      },
    });
    if (!gasto) throw new AuthzError(404, "Gasto no encontrado");
    await requireMembership(gasto.companyId, undefined, req);
    await requireModule(gasto.companyId, "CONSTRUCCION");

    // CFDI ya vinculado a ESTE gasto (si existe).
    const vinculoActual = await prisma.construccionCfdiVinculo.findFirst({
      where: {
        companyId: gasto.companyId,
        estado: "VINCULADA",
        targetTipo: "GASTO",
        targetId: gasto.id,
      },
      select: {
        invoice: {
          select: {
            id: true,
            uuid: true,
            fecha: true,
            total: true,
            customer: { select: { rfc: true, razonSocial: true } },
            contraparteNombre: true,
            contraparteRfc: true,
          },
        },
      },
    });

    const ref = gasto.pagadoAt ?? gasto.createdAt;
    const desde = new Date(ref);
    desde.setDate(desde.getDate() - DIAS_VENTANA);
    const hasta = new Date(ref);
    hasta.setDate(hasta.getDate() + DIAS_VENTANA);

    const invoices = await prisma.invoice.findMany({
      where: {
        companyId: gasto.companyId,
        tipo: "EGRESO",
        status: { not: "CANCELLED" },
        fecha: { gte: desde, lte: hasta },
        construccionVinculo: null, // sin vincular ni ignorar
      },
      select: {
        id: true,
        uuid: true,
        fecha: true,
        total: true,
        customer: { select: { rfc: true, razonSocial: true } },
        contraparteNombre: true,
        contraparteRfc: true,
      },
      orderBy: { fecha: "desc" },
      take: 300,
    });

    const importe = Number(gasto.importe);
    const rfcGasto = gasto.supplier?.rfc?.toUpperCase() ?? null;
    const scored = invoices
      .map((inv) => {
        const total = Number(inv.total);
        const rfc = (inv.customer?.rfc ?? inv.contraparteRfc ?? "").toUpperCase();
        const razones: string[] = [];
        let score = 0;
        if (rfcGasto && rfc && rfc === rfcGasto) {
          score += 100;
          razones.push("RFC del proveedor coincide");
        }
        const drift = Math.abs(total - importe);
        if (drift <= Math.max(1, importe * 0.01)) {
          score += 80;
          razones.push("monto exacto");
        } else if (importe > 0 && drift / importe <= 0.25) {
          score += Math.round(80 * (1 - drift / importe / 0.25) * 0.6);
          razones.push("monto cercano");
        }
        const dias = Math.abs(+inv.fecha - +ref) / 86400000;
        score += Math.max(0, Math.round(20 * (1 - dias / DIAS_VENTANA)));
        return {
          id: inv.id,
          uuid: inv.uuid,
          fecha: inv.fecha,
          total,
          emisorRfc: inv.customer?.rfc ?? inv.contraparteRfc ?? null,
          emisorNombre: inv.customer?.razonSocial ?? inv.contraparteNombre ?? null,
          score,
          razones,
        };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    const vinculado = vinculoActual?.invoice
      ? {
          id: vinculoActual.invoice.id,
          uuid: vinculoActual.invoice.uuid,
          fecha: vinculoActual.invoice.fecha,
          total: Number(vinculoActual.invoice.total),
          emisorRfc: vinculoActual.invoice.customer?.rfc ?? vinculoActual.invoice.contraparteRfc ?? null,
          emisorNombre:
            vinculoActual.invoice.customer?.razonSocial ?? vinculoActual.invoice.contraparteNombre ?? null,
        }
      : null;

    return NextResponse.json({ vinculado, candidatos: scored });
  }
);
