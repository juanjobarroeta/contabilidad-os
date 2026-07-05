/**
 * GET /api/construccion/proyectos/[id]/costos
 *
 * Rollup de costos del proyecto — los cuatro números honestos, cada uno de su
 * propia fuente (Fase C de la cuenta corriente):
 *
 *   solicitado   — requisiciones enviadas (PENDIENTE+): lo adjudicado usa su
 *                  total real; lo pendiente se estima con la oferta más baja.
 *   comprometido — adjudicaciones autorizadas (costo comprometido: se devenga
 *                  al comprometer, no al pagar) + gastos aprobados/pagados.
 *   facturado    — CFDIs vinculados (atribución) a requisiciones/gastos del
 *                  proyecto.
 *   pagadoReal   — Σ aplicaciones de pagos sobre las adjudicaciones del
 *                  proyecto (+ adjudicaciones PAGADA legacy sin aplicaciones)
 *                  + gastos PAGADO.
 *
 * presupuestoTotal (contexto): montoTotal del presupuesto base del proyecto.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, withAuthz } from "@/lib/authz";

const round2 = (n: number) => Math.round(n * 100) / 100;

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const proyecto = await prisma.proyecto.findUnique({
      where: { id },
      select: {
        id: true,
        companyId: true,
        presupuestos: {
          select: { id: true, tipoPresupuesto: true, estado: true, montoTotal: true },
        },
      },
    });
    if (!proyecto) throw new AuthzError(404, "Proyecto no encontrado");
    await requireMembership(proyecto.companyId, undefined, req);
    await requireModule(proyecto.companyId, "CONSTRUCCION");

    // Presupuesto base: misma prioridad que la explosión (EJECUTADO → aprobado
    // /en ejecución → el primero).
    const presups = proyecto.presupuestos;
    const basis =
      presups.find((p) => p.tipoPresupuesto === "EJECUTADO") ??
      presups.find((p) => p.estado === "APROBADO" || p.estado === "EN_EJECUCION") ??
      presups[0];

    const solicitudes = await prisma.solicitudCompra.findMany({
      where: { proyectoId: id, estado: { in: ["PENDIENTE", "APROBADA", "PAGADA"] } },
      select: {
        id: true,
        estado: true,
        total: true,
        cotizaciones: { select: { total: true } },
        adjudicaciones: {
          select: {
            id: true,
            total: true,
            estado: true,
            aplicaciones: { select: { monto: true } },
          },
        },
      },
    });

    let solicitado = 0;
    let comprometido = 0;
    let pagadoReal = 0;
    for (const s of solicitudes) {
      const adjTotal = s.adjudicaciones.reduce((a, x) => a + x.total, 0);
      if (s.estado === "PENDIENTE") {
        // Aún sin adjudicar: estimado = oferta más baja (si hay cotizaciones).
        const ofertas = s.cotizaciones.map((c) => c.total).filter((t) => t > 0);
        solicitado += ofertas.length ? Math.min(...ofertas) : s.total;
      } else {
        solicitado += adjTotal || s.total;
        comprometido += adjTotal || s.total;
      }
      for (const a of s.adjudicaciones) {
        const aplicado = a.aplicaciones.reduce((x, y) => x + y.monto, 0);
        // Tolerancia legacy: PAGADA/CONCILIADA del flujo anterior sin
        // aplicaciones cuenta como pagada por su total.
        if (aplicado > 0.01) pagadoReal += Math.min(aplicado, a.total);
        else if (a.estado === "PAGADA" || a.estado === "CONCILIADA") pagadoReal += a.total;
      }
    }

    // Gastos del proyecto: aprobados/pagados comprometen; pagados cuentan
    // como pagado real.
    const gastos = await prisma.gasto.groupBy({
      by: ["estado"],
      where: { proyectoId: id, estado: { in: ["APROBADO", "PAGADO"] } },
      _sum: { importe: true },
    });
    const gastosAprobados = gastos.find((g) => g.estado === "APROBADO")?._sum.importe ?? 0;
    const gastosPagados = gastos.find((g) => g.estado === "PAGADO")?._sum.importe ?? 0;
    comprometido += gastosAprobados + gastosPagados;
    solicitado += gastosAprobados + gastosPagados;
    pagadoReal += gastosPagados;

    // Facturado: CFDIs vinculados (atribución) a requisiciones o gastos del
    // proyecto.
    const [solicitudIds, gastoIds] = await Promise.all([
      prisma.solicitudCompra
        .findMany({ where: { proyectoId: id }, select: { id: true } })
        .then((r) => r.map((x) => x.id)),
      prisma.gasto
        .findMany({ where: { proyectoId: id }, select: { id: true } })
        .then((r) => r.map((x) => x.id)),
    ]);
    const vinculos = await prisma.construccionCfdiVinculo.findMany({
      where: {
        companyId: proyecto.companyId,
        estado: "VINCULADA",
        OR: [
          ...(solicitudIds.length ? [{ targetTipo: "SOLICITUD", targetId: { in: solicitudIds } }] : []),
          ...(gastoIds.length ? [{ targetTipo: "GASTO", targetId: { in: gastoIds } }] : []),
        ],
      },
      select: { invoice: { select: { total: true } } },
    });
    const facturado = vinculos.reduce((s, v) => s + (v.invoice?.total ?? 0), 0);

    return NextResponse.json({
      proyectoId: id,
      presupuestoTotal: basis?.montoTotal ?? null,
      solicitado: round2(solicitado),
      comprometido: round2(comprometido),
      facturado: round2(facturado),
      pagadoReal: round2(pagadoReal),
    });
  }
);
