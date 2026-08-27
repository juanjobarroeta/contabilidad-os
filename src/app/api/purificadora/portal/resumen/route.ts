import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withAuthz } from "@/lib/authz";
import { requirePortalAccount } from "@/lib/purificadora/portal";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// GET /api/purificadora/portal/resumen — datos fiscales del cliente + su
// consumo de garrafones (mes actual, 12 meses, saldo pendiente). Todo acotado
// al customerId del token del portal.
export const GET = withAuthz(async (req: Request) => {
  const ctx = await requirePortalAccount(req);

  const now = new Date();
  const inicioMes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const hace12 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));

  const [customer, config, clienteConfig, mesActual, pendiente, ventas12] = await Promise.all([
    prisma.customer.findUnique({
      where: { id: ctx.customerId },
      select: {
        razonSocial: true,
        rfc: true,
        regimenFiscal: true,
        codigoPostal: true,
        email: true,
      },
    }),
    prisma.purifConfig.findUnique({ where: { companyId: ctx.companyId } }),
    prisma.purifClienteConfig.findUnique({
      where: { companyId_customerId: { companyId: ctx.companyId, customerId: ctx.customerId } },
    }),
    prisma.purifVenta.aggregate({
      where: {
        companyId: ctx.companyId,
        customerId: ctx.customerId,
        estado: { not: "CANCELADA" },
        fecha: { gte: inicioMes },
      },
      _sum: { total: true, garrafones: true },
      _count: true,
    }),
    prisma.purifVenta.aggregate({
      where: { companyId: ctx.companyId, customerId: ctx.customerId, estado: "PENDIENTE" },
      _sum: { total: true },
      _count: true,
    }),
    prisma.purifVenta.findMany({
      where: {
        companyId: ctx.companyId,
        customerId: ctx.customerId,
        estado: { not: "CANCELADA" },
        fecha: { gte: hace12 },
      },
      select: { fecha: true, total: true, garrafones: true },
    }),
  ]);

  // Serie mensual de los últimos 12 meses.
  const meses: { mes: string; garrafones: number; total: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    meses.push({ mes: d.toISOString().slice(0, 7), garrafones: 0, total: 0 });
  }
  const porMes = new Map(meses.map((m) => [m.mes, m]));
  for (const v of ventas12) {
    const bucket = porMes.get(v.fecha.toISOString().slice(0, 7));
    if (bucket) {
      bucket.garrafones += v.garrafones;
      bucket.total = round2(bucket.total + Number(v.total));
    }
  }

  return NextResponse.json({
    cliente: customer,
    negocio: config?.nombreComercial ?? null,
    precioGarrafon: clienteConfig?.precioGarrafon ?? config?.precioGarrafon ?? null,
    mesActual: {
      garrafones: mesActual._sum.garrafones ?? 0,
      total: round2(Number(mesActual._sum.total ?? 0)),
      entregas: mesActual._count,
    },
    saldoPendiente: {
      total: round2(Number(pendiente._sum.total ?? 0)),
      entregas: pendiente._count,
    },
    meses,
  });
});
