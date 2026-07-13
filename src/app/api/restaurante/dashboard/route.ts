/**
 * GET /api/restaurante/dashboard?companyId=... [&from=ISO] [&to=ISO]
 *
 * Operational snapshot for the satellite home screen. `from`/`to` bound the
 * "today" window — the client sends its local midnight so the day rolls over
 * at the restaurant's timezone, not UTC. Defaults to the current UTC day.
 *
 * Returns: ventas del día (count/total/propinas/costo → food cost real),
 * órdenes abiertas, insumos bajo mínimo, compras por pagar, top platillos.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { round2 } from "@/lib/restaurante";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "RESTAURANTE", req);

  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const from = fromParam ? new Date(fromParam) : new Date(new Date().setUTCHours(0, 0, 0, 0));
  const to = toParam ? new Date(toParam) : undefined;

  const [cobradas, abiertas, insumos, comprasPorPagar] = await Promise.all([
    prisma.restOrden.findMany({
      where: { companyId, estado: "COBRADA", cobradaAt: { gte: from, ...(to ? { lt: to } : {}) } },
      select: {
        subtotal: true,
        total: true,
        propina: true,
        costoTotal: true,
        formaPago: true,
        items: {
          where: { estadoCocina: { not: "CANCELADO" } },
          select: {
            cantidad: true,
            precioUnitario: true,
            menuItem: { select: { id: true, nombre: true } },
          },
        },
      },
    }),
    prisma.restOrden.count({ where: { companyId, estado: "ABIERTA" } }),
    prisma.restInsumo.findMany({
      where: { companyId, activo: true, stockMinimo: { gt: 0 } },
      select: { id: true, nombre: true, unidad: true, stock: true, stockMinimo: true },
    }),
    prisma.restCompra.count({ where: { companyId, estado: "RECIBIDA" } }),
  ]);

  const ventasTotal = round2(cobradas.reduce((s, o) => s + o.total, 0));
  const ventasSubtotal = round2(cobradas.reduce((s, o) => s + o.subtotal, 0));
  const propinas = round2(cobradas.reduce((s, o) => s + o.propina, 0));
  const costo = round2(cobradas.reduce((s, o) => s + o.costoTotal, 0));

  const porFormaPago: Record<string, number> = {};
  for (const o of cobradas) {
    const key = o.formaPago ?? "OTRO";
    porFormaPago[key] = round2((porFormaPago[key] ?? 0) + o.total + o.propina);
  }

  const topMap = new Map<string, { nombre: string; cantidad: number; venta: number }>();
  for (const o of cobradas) {
    for (const i of o.items) {
      const cur = topMap.get(i.menuItem.id) ?? { nombre: i.menuItem.nombre, cantidad: 0, venta: 0 };
      cur.cantidad += i.cantidad;
      cur.venta = round2(cur.venta + i.cantidad * i.precioUnitario);
      topMap.set(i.menuItem.id, cur);
    }
  }
  const topPlatillos = [...topMap.entries()]
    .map(([menuItemId, v]) => ({ menuItemId, ...v }))
    .sort((a, b) => b.venta - a.venta)
    .slice(0, 10);

  return NextResponse.json({
    ventas: {
      ordenes: cobradas.length,
      total: ventasTotal,
      subtotal: ventasSubtotal,
      propinas,
      costo,
      foodCostPct: ventasSubtotal > 0 ? Math.round((costo / ventasSubtotal) * 1000) / 1000 : 0,
      porFormaPago,
    },
    ordenesAbiertas: abiertas,
    insumosBajoMinimo: insumos.filter((i) => i.stock <= i.stockMinimo),
    comprasPorPagar,
    topPlatillos,
  });
});
