import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// GET /api/purificadora/dashboard?companyId=xxx
// KPIs del negocio: garrafones e ingresos de hoy y del mes, gastos del mes,
// saldo por cobrar, serie de los últimos 14 días, top clientes del mes y
// gastos del mes por categoría.
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const now = new Date();
  const hoy = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);
  const hace14 = new Date(hoy.getTime() - 13 * 86400000);

  const [ventasHoy, ventasMes, gastosMes, comprasMes, porCobrar, ventas14, topClientesRaw, gastosCat] =
    await Promise.all([
      prisma.purifVenta.aggregate({
        where: { companyId, fecha: { gte: hoy }, estado: { not: "CANCELADA" } },
        _sum: { total: true, garrafones: true },
        _count: true,
      }),
      prisma.purifVenta.aggregate({
        where: { companyId, fecha: { gte: inicioMes }, estado: { not: "CANCELADA" } },
        _sum: { total: true, garrafones: true },
        _count: true,
      }),
      prisma.purifGasto.aggregate({
        where: { companyId, fecha: { gte: inicioMes } },
        _sum: { monto: true },
        _count: true,
      }),
      prisma.purifCompra.aggregate({
        where: { companyId, estado: { not: "CANCELADA" }, fecha: { gte: inicioMes } },
        _sum: { total: true },
        _count: true,
      }),
      prisma.purifVenta.aggregate({
        where: { companyId, estado: "PENDIENTE" },
        _sum: { total: true },
        _count: true,
      }),
      prisma.purifVenta.findMany({
        where: { companyId, fecha: { gte: hace14 }, estado: { not: "CANCELADA" } },
        select: { fecha: true, total: true, garrafones: true },
      }),
      prisma.purifVenta.groupBy({
        by: ["customerId"],
        where: {
          companyId,
          fecha: { gte: inicioMes },
          estado: { not: "CANCELADA" },
          customerId: { not: null },
        },
        _sum: { total: true, garrafones: true },
        _count: true,
        orderBy: { _sum: { garrafones: "desc" } },
        take: 5,
      }),
      prisma.purifGasto.groupBy({
        by: ["categoria"],
        where: { companyId, fecha: { gte: inicioMes } },
        _sum: { monto: true },
        orderBy: { _sum: { monto: "desc" } },
      }),
    ]);

  // Serie diaria de los últimos 14 días (huecos en cero).
  const porDia = new Map<string, { ingresos: number; garrafones: number }>();
  for (let i = 0; i < 14; i++) {
    const d = new Date(hace14.getTime() + i * 86400000);
    porDia.set(d.toISOString().slice(0, 10), { ingresos: 0, garrafones: 0 });
  }
  for (const v of ventas14) {
    const key = new Date(v.fecha.getFullYear(), v.fecha.getMonth(), v.fecha.getDate())
      .toISOString()
      .slice(0, 10);
    const bucket = porDia.get(key);
    if (bucket) {
      bucket.ingresos = round2(bucket.ingresos + v.total);
      bucket.garrafones += v.garrafones;
    }
  }

  // Nombres de los top clientes.
  const clienteIds = topClientesRaw.map((t) => t.customerId).filter(Boolean) as string[];
  const clientes = clienteIds.length
    ? await prisma.customer.findMany({
        where: { id: { in: clienteIds } },
        select: { id: true, razonSocial: true },
      })
    : [];
  const nombreById = new Map(clientes.map((c) => [c.id, c.razonSocial]));

  const ingresosMes = round2(ventasMes._sum.total ?? 0);
  // Gastos del mes = gastos rápidos + compras a proveedor (no canceladas).
  const gastosMesTotal = round2((gastosMes._sum.monto ?? 0) + (comprasMes._sum.total ?? 0));

  return NextResponse.json({
    hoy: {
      ventas: ventasHoy._count,
      ingresos: round2(ventasHoy._sum.total ?? 0),
      garrafones: ventasHoy._sum.garrafones ?? 0,
    },
    mes: {
      ventas: ventasMes._count,
      ingresos: ingresosMes,
      garrafones: ventasMes._sum.garrafones ?? 0,
      gastos: gastosMesTotal,
      gastosCount: gastosMes._count + comprasMes._count,
      utilidad: round2(ingresosMes - gastosMesTotal),
    },
    porCobrar: {
      ventas: porCobrar._count,
      total: round2(porCobrar._sum.total ?? 0),
    },
    serie14dias: [...porDia.entries()].map(([fecha, v]) => ({ fecha, ...v })),
    topClientes: topClientesRaw.map((t) => ({
      customerId: t.customerId,
      nombre: nombreById.get(t.customerId!) ?? "—",
      garrafones: t._sum.garrafones ?? 0,
      total: round2(t._sum.total ?? 0),
      ventas: t._count,
    })),
    gastosPorCategoria: gastosCat.map((g) => ({
      categoria: g.categoria,
      total: round2(g._sum.monto ?? 0),
    })),
  });
});
