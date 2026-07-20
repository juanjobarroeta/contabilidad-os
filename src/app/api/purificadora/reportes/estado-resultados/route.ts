import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// GET /api/purificadora/reportes/estado-resultados?companyId=xxx&year=2026&month=7
//
// Estado de resultados operativo del mes:
//   Ingresos (ventas no canceladas) — desglosados en cobrado / por cobrar
//   (−) Costo del agua (gastos AGUA_CRUDA: pipas / agua cruda)
//   = Utilidad bruta
//   (−) Gastos de operación (las demás categorías, itemizadas)
//   = Utilidad de operación
// Es la vista operativa del módulo; el estado de resultados contable formal
// (sobre AccountingEntry) vive en contabilidad-os.
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const year = parseInt(searchParams.get("year") ?? "");
  const month = parseInt(searchParams.get("month") ?? "");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  if (!year || !month || month < 1 || month > 12) {
    return NextResponse.json({ error: "year y month requeridos" }, { status: 400 });
  }

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const desde = new Date(Date.UTC(year, month - 1, 1));
  const hasta = new Date(Date.UTC(year, month, 1));

  const [ventas, gastosCat, cortesias] = await Promise.all([
    prisma.purifVenta.groupBy({
      by: ["estado"],
      where: { companyId, estado: { not: "CANCELADA" }, fecha: { gte: desde, lt: hasta } },
      _sum: { total: true, garrafones: true },
      _count: true,
    }),
    prisma.purifGasto.groupBy({
      by: ["categoria"],
      where: { companyId, fecha: { gte: desde, lt: hasta } },
      _sum: { monto: true },
      orderBy: { _sum: { monto: "desc" } },
    }),
    prisma.purifCorte.aggregate({
      where: { companyId, estado: "CONFIRMADO", fecha: { gte: desde, lt: hasta } },
      _sum: { cortesiasGarrafones: true, cortesiasImporte: true },
    }),
  ]);

  const porEstado = new Map(ventas.map((v) => [v.estado, v]));
  const cobrado = round2(porEstado.get("COBRADA")?._sum.total ?? 0);
  const porCobrar = round2(porEstado.get("PENDIENTE")?._sum.total ?? 0);
  const ingresos = round2(cobrado + porCobrar);
  const garrafones =
    (porEstado.get("COBRADA")?._sum.garrafones ?? 0) +
    (porEstado.get("PENDIENTE")?._sum.garrafones ?? 0);

  // Costo directo del agua = agua cruda / pipas. El resto es gasto de operación.
  const costoAgua = round2(
    gastosCat.find((g) => g.categoria === "AGUA_CRUDA")?._sum.monto ?? 0
  );
  const gastosOperacion = gastosCat
    .filter((g) => g.categoria !== "AGUA_CRUDA")
    .map((g) => ({ categoria: g.categoria, total: round2(g._sum.monto ?? 0) }));
  const totalGastosOperacion = round2(gastosOperacion.reduce((s, g) => s + g.total, 0));

  const utilidadBruta = round2(ingresos - costoAgua);
  const utilidadOperacion = round2(utilidadBruta - totalGastosOperacion);

  return NextResponse.json({
    year,
    month,
    ingresos: {
      total: ingresos,
      cobrado,
      porCobrar,
      garrafones,
      ventasCobradas: porEstado.get("COBRADA")?._count ?? 0,
      ventasPorCobrar: porEstado.get("PENDIENTE")?._count ?? 0,
    },
    cortesias: {
      garrafones: cortesias._sum.cortesiasGarrafones ?? 0,
      importe: round2(cortesias._sum.cortesiasImporte ?? 0),
    },
    costoAgua,
    utilidadBruta,
    margenBruto: ingresos > 0 ? round2((utilidadBruta / ingresos) * 100) : null,
    gastosOperacion,
    totalGastosOperacion,
    utilidadOperacion,
    margenOperacion: ingresos > 0 ? round2((utilidadOperacion / ingresos) * 100) : null,
  });
});
