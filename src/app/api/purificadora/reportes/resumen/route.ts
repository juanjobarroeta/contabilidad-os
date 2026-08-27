import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// GET /api/purificadora/reportes/resumen?companyId=xxx&year=2026
//
// La hoja "RESUMEN" del Excel: por cliente, ingresos y garrafones de cada mes
// del año (+ la fila de casas/rutas y la de gastos).
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const year = parseInt(searchParams.get("year") ?? "");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  if (!year) return NextResponse.json({ error: "year requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const desde = new Date(Date.UTC(year, 0, 1));
  const hasta = new Date(Date.UTC(year + 1, 0, 1));

  const [ventas, gastos] = await Promise.all([
    prisma.purifVenta.findMany({
      where: { companyId, estado: { not: "CANCELADA" }, fecha: { gte: desde, lt: hasta } },
      select: {
        fecha: true,
        total: true,
        garrafones: true,
        customerId: true,
        customer: { select: { razonSocial: true } },
      },
    }),
    prisma.purifGasto.findMany({
      where: { companyId, fecha: { gte: desde, lt: hasta } },
      select: { fecha: true, monto: true },
    }),
  ]);

  type Row = {
    key: string;
    nombre: string;
    ingresos: number[]; // index 0-11
    garrafones: number[];
    totalIngresos: number;
    totalGarrafones: number;
  };
  const rows = new Map<string, Row>();
  const rowFor = (key: string, nombre: string): Row => {
    let r = rows.get(key);
    if (!r) {
      r = {
        key,
        nombre,
        ingresos: Array(12).fill(0),
        garrafones: Array(12).fill(0),
        totalIngresos: 0,
        totalGarrafones: 0,
      };
      rows.set(key, r);
    }
    return r;
  };

  for (const v of ventas) {
    const m = v.fecha.getUTCMonth();
    const row = v.customerId
      ? rowFor(v.customerId, v.customer!.razonSocial)
      : rowFor("__casas__", "Casas / rutas");
    row.ingresos[m] = round2(row.ingresos[m] + Number(v.total));
    row.garrafones[m] += v.garrafones;
    row.totalIngresos = round2(row.totalIngresos + Number(v.total));
    row.totalGarrafones += v.garrafones;
  }

  const gastosPorMes = Array(12).fill(0);
  let totalGastos = 0;
  for (const g of gastos) {
    const m = g.fecha.getUTCMonth();
    gastosPorMes[m] = round2(gastosPorMes[m] + Number(g.monto));
    totalGastos = round2(totalGastos + Number(g.monto));
  }

  const list = [...rows.values()].sort((a, b) => b.totalIngresos - a.totalIngresos);
  const ingresosPorMes = Array(12).fill(0);
  for (const r of list) {
    r.ingresos.forEach((v, i) => {
      ingresosPorMes[i] = round2(ingresosPorMes[i] + v);
    });
  }

  return NextResponse.json({
    year,
    rows: list,
    ingresosPorMes,
    gastosPorMes,
    totalIngresos: round2(ingresosPorMes.reduce((s, v) => s + v, 0)),
    totalGastos,
  });
});
