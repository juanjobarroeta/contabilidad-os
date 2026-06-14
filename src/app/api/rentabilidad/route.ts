import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOperador } from "@/lib/authz";
import { microUsdACentavosMxn } from "@/lib/costos/rates";
import { fetchTipoCambioFix } from "@/lib/fiscal/banxico";

// GET /api/rentabilidad?year=YYYY&month=M
// Unit economics (SÓLO operador de plataforma): costo-por-servir del periodo vs
// precio mensual → margen, por empresa y con roll-up por despacho. Costo viene de
// CostEvent (micro-USD); se convierte a centavos MXN con el FIX de Banxico.

const pad = (n: number) => String(n).padStart(2, "0");

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isOperador(session.user.id))) {
    return NextResponse.json({ error: "Sólo disponible para operador de plataforma" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const now = new Date();
  const year = parseInt(searchParams.get("year") ?? "") || now.getFullYear();
  const month = parseInt(searchParams.get("month") ?? "") || now.getMonth() + 1;
  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month, 1);

  const fix = (await fetchTipoCambioFix())?.valor ?? null;
  const fixUsado = fix ?? 20; // fallback aproximado si Banxico no responde

  const [companies, despachos, porEmpresa, overheadDespacho] = await Promise.all([
    prisma.company.findMany({
      where: { isActive: true },
      select: { id: true, razonSocial: true, rfc: true, despachoId: true, precioMensualCentavos: true },
      orderBy: { razonSocial: "asc" },
    }),
    prisma.despacho.findMany({ select: { id: true, name: true, precioMensualCentavos: true }, orderBy: { name: "asc" } }),
    prisma.costEvent.groupBy({
      by: ["companyId"],
      where: { occurredAt: { gte: from, lt: to }, companyId: { not: null } },
      _sum: { costoMicroUsd: true },
      _count: { _all: true },
    }),
    // Costos de despacho sin empresa (p.ej. parseos de onboarding) = overhead.
    prisma.costEvent.groupBy({
      by: ["despachoId"],
      where: { occurredAt: { gte: from, lt: to }, companyId: null, despachoId: { not: null } },
      _sum: { costoMicroUsd: true },
    }),
  ]);

  const microPorEmpresa = new Map(porEmpresa.map((g) => [g.companyId, { micro: g._sum.costoMicroUsd ?? 0, eventos: g._count._all }]));
  const overheadMicroPorDespacho = new Map(overheadDespacho.map((g) => [g.despachoId, g._sum.costoMicroUsd ?? 0]));

  const empresas = companies.map((c) => {
    const agg = microPorEmpresa.get(c.id);
    const costoCentavos = microUsdACentavosMxn(agg?.micro ?? 0, fixUsado);
    const precio = c.precioMensualCentavos ?? null;
    const margen = precio != null ? precio - costoCentavos : null;
    return {
      companyId: c.id,
      razonSocial: c.razonSocial,
      rfc: c.rfc,
      despachoId: c.despachoId,
      precioMensualCentavos: precio,
      costoCentavos,
      eventos: agg?.eventos ?? 0,
      margenCentavos: margen,
      margenPct: precio && precio > 0 && margen != null ? margen / precio : null,
    };
  });

  const despachosOut = despachos.map((d) => {
    const empresasD = empresas.filter((e) => e.despachoId === d.id);
    const costoEmpresas = empresasD.reduce((s, e) => s + e.costoCentavos, 0);
    const overheadCentavos = microUsdACentavosMxn(overheadMicroPorDespacho.get(d.id) ?? 0, fixUsado);
    const costoCentavos = costoEmpresas + overheadCentavos;
    const precio = d.precioMensualCentavos ?? null;
    const margen = precio != null ? precio - costoCentavos : null;
    return {
      despachoId: d.id,
      name: d.name,
      empresas: empresasD.length,
      precioMensualCentavos: precio,
      costoCentavos,
      overheadCentavos,
      margenCentavos: margen,
      margenPct: precio && precio > 0 && margen != null ? margen / precio : null,
    };
  });

  // Total para el encabezado.
  const totalCostoCentavos = empresas.reduce((s, e) => s + e.costoCentavos, 0) +
    despachosOut.reduce((s, d) => s + d.overheadCentavos, 0);

  return NextResponse.json({
    periodo: `${year}-${pad(month)}`,
    fixMxnPorUsd: fixUsado,
    fixReal: fix != null,
    totalCostoCentavos,
    empresas,
    despachos: despachosOut,
  });
}
