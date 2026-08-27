import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// GET /api/purificadora/clientes/resumen?companyId=xxx
// Resumen por cliente: garrafones acumulados, total comprado, saldo pendiente
// (ventas a crédito sin cobrar) y fecha de última compra. Los clientes viven
// en el modelo canónico Customer del hub; aquí sólo se agrega la telemetría
// del negocio de agua.
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const [clientes, compras, pendientes] = await Promise.all([
    prisma.customer.findMany({
      where: { companyId },
      select: { id: true, razonSocial: true, rfc: true, phone: true, email: true },
      orderBy: { razonSocial: "asc" },
    }),
    prisma.purifVenta.groupBy({
      by: ["customerId"],
      where: { companyId, estado: { not: "CANCELADA" }, customerId: { not: null } },
      _sum: { total: true, garrafones: true },
      _count: true,
      _max: { fecha: true },
    }),
    prisma.purifVenta.groupBy({
      by: ["customerId"],
      where: { companyId, estado: "PENDIENTE", customerId: { not: null } },
      _sum: { total: true },
    }),
  ]);

  const compraById = new Map(compras.map((c) => [c.customerId, c]));
  const pendienteById = new Map(pendientes.map((p) => [p.customerId, Number(p._sum.total ?? 0)]));

  const resumen = clientes.map((c) => {
    const compra = compraById.get(c.id);
    return {
      ...c,
      ventas: compra?._count ?? 0,
      garrafones: compra?._sum.garrafones ?? 0,
      totalComprado: round2(Number(compra?._sum.total ?? 0)),
      saldoPendiente: round2(pendienteById.get(c.id) ?? 0),
      ultimaCompra: compra?._max.fecha ?? null,
    };
  });

  // Los que más compran primero; clientes sin compras al final.
  resumen.sort((a, b) => b.garrafones - a.garrafones || b.totalComprado - a.totalComprado);

  return NextResponse.json(resumen);
});
