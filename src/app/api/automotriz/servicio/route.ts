import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/automotriz/servicio?companyId=…&year=2026
//
// Reportes del taller (lado lectura, derivado de CFDIs): venta de servicio por
// mes (mano de obra vs refacciones), ticket promedio, top clientes, clientes
// que no regresan (≥2 servicios y >6 meses sin venir) y últimas facturas.
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const year = Number(searchParams.get("year") ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: "Ejercicio inválido" }, { status: 400 });
  }
  const desde = new Date(year, 0, 1);
  const hasta = new Date(year + 1, 0, 1);

  const [delAnio, topClientesRaw, ultimas, noRegresanRaw] = await Promise.all([
    prisma.servicioVenta.findMany({
      where: { companyId, fecha: { gte: desde, lt: hasta } },
      select: { fecha: true, total: true, manoObra: true, refacciones: true },
    }),
    prisma.servicioVenta.groupBy({
      by: ["clienteId"],
      where: { companyId, fecha: { gte: desde, lt: hasta }, clienteId: { not: null } },
      _count: { _all: true },
      _sum: { total: true },
      orderBy: { _sum: { total: "desc" } },
      take: 10,
    }),
    prisma.servicioVenta.findMany({
      where: { companyId },
      orderBy: { fecha: "desc" },
      take: 20,
      include: {
        cliente: { select: { id: true, razonSocial: true } },
        vehiculo: { select: { id: true, vin: true, marca: true, modelo: true, anio: true } },
        invoice: { select: { id: true, serie: true, folio: true } },
      },
    }),
    // Clientes que no regresan: ≥2 servicios históricos y el último hace >6 meses.
    prisma.servicioVenta.groupBy({
      by: ["clienteId"],
      where: { companyId, clienteId: { not: null } },
      _count: { _all: true },
      _max: { fecha: true },
      _sum: { total: true },
    }),
  ]);

  const porMes = new Map<number, { facturas: number; total: number; manoObra: number; refacciones: number }>();
  for (const s of delAnio) {
    const m = new Date(s.fecha).getMonth() + 1;
    const a = porMes.get(m) ?? { facturas: 0, total: 0, manoObra: 0, refacciones: 0 };
    a.facturas++;
    a.total = r2(a.total + Number(s.total));
    a.manoObra = r2(a.manoObra + Number(s.manoObra));
    a.refacciones = r2(a.refacciones + Number(s.refacciones));
    porMes.set(m, a);
  }

  const seisMeses = new Date();
  seisMeses.setMonth(seisMeses.getMonth() - 6);
  const noRegresanIds = noRegresanRaw
    .filter((c) => c._count._all >= 2 && c._max.fecha && c._max.fecha < seisMeses)
    .sort((a, b) => Number(b._sum.total ?? 0) - Number(a._sum.total ?? 0))
    .slice(0, 15);

  const clienteIds = [
    ...new Set([...topClientesRaw, ...noRegresanIds].map((c) => c.clienteId).filter(Boolean)),
  ] as string[];
  const clientes = clienteIds.length
    ? await prisma.customer.findMany({
        where: { id: { in: clienteIds } },
        select: { id: true, razonSocial: true },
      })
    : [];
  const nombre = new Map(clientes.map((c) => [c.id, c.razonSocial]));

  const totalAnio = r2(delAnio.reduce((s, x) => s + Number(x.total), 0));
  return NextResponse.json({
    year,
    resumen: {
      facturas: delAnio.length,
      total: totalAnio,
      manoObra: r2(delAnio.reduce((s, x) => s + Number(x.manoObra), 0)),
      refacciones: r2(delAnio.reduce((s, x) => s + Number(x.refacciones), 0)),
      ticketPromedio: delAnio.length ? r2(totalAnio / delAnio.length) : null,
    },
    porMes: [...porMes.entries()].sort((a, b) => a[0] - b[0]).map(([mes, a]) => ({ mes, ...a })),
    topClientes: topClientesRaw.map((c) => ({
      clienteId: c.clienteId,
      razonSocial: nombre.get(c.clienteId!) ?? "—",
      servicios: c._count._all,
      total: r2(Number(c._sum.total ?? 0)),
    })),
    noRegresan: noRegresanIds.map((c) => ({
      clienteId: c.clienteId,
      razonSocial: nombre.get(c.clienteId!) ?? "—",
      servicios: c._count._all,
      ultimaVisita: c._max.fecha,
      totalHistorico: r2(Number(c._sum.total ?? 0)),
    })),
    ultimas,
  });
});
