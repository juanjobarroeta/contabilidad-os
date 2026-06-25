// Cálculo de rentabilidad (unit economics) reutilizable: costo-por-servir del
// mes vs precio mensual → margen, por empresa y con roll-up por despacho. Lo
// consumen la API /rentabilidad, las alertas y el cron. Costo en CostEvent
// (micro-USD) → centavos MXN con el FIX de Banxico.

import type { CompanyPlan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { microUsdACentavosMxn } from "./rates";
import { fetchTipoCambioFix } from "@/lib/fiscal/banxico";

export interface RentabilidadEmpresa {
  companyId: string;
  razonSocial: string;
  rfc: string;
  despachoId: string | null;
  plan: CompanyPlan;
  precioMensualCentavos: number | null;
  costoCentavos: number;
  /** Desglose del costo-por-servir: datos (Syntage) vs IA (LLM) vs timbrado (Facturapi). */
  costoSyntageCentavos: number;
  costoLlmCentavos: number;
  costoFacturapiCentavos: number;
  /** Timbres consumidos en el periodo (facturas + nómina + REP). */
  timbresMes: number;
  eventos: number;
  margenCentavos: number | null;
  margenPct: number | null;
}
export interface RentabilidadDespacho {
  despachoId: string;
  name: string;
  empresas: number;
  precioMensualCentavos: number | null;
  costoCentavos: number;
  overheadCentavos: number;
  margenCentavos: number | null;
  margenPct: number | null;
}
export interface Rentabilidad {
  periodo: string;
  fixMxnPorUsd: number;
  fixReal: boolean;
  totalCostoCentavos: number;
  totalSyntageCentavos: number;
  totalLlmCentavos: number;
  totalFacturapiCentavos: number;
  empresas: RentabilidadEmpresa[];
  despachos: RentabilidadDespacho[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** True si hay precio (> 0) y el costo lo excede → cliente "bajo agua". */
export function esBajoAgua(precioMensualCentavos: number | null, costoCentavos: number): boolean {
  return precioMensualCentavos != null && precioMensualCentavos > 0 && costoCentavos > precioMensualCentavos;
}

export async function computeRentabilidad(year: number, month: number): Promise<Rentabilidad> {
  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month, 1);

  const fix = (await fetchTipoCambioFix())?.valor ?? null;
  const fixUsado = fix ?? 20; // fallback aproximado si Banxico no responde

  const [companies, despachos, porEmpresa, porEmpresaCategoria, overheadDespacho] = await Promise.all([
    prisma.company.findMany({
      where: { isActive: true },
      select: { id: true, razonSocial: true, rfc: true, despachoId: true, tier: true, precioMensualCentavos: true },
      orderBy: { razonSocial: "asc" },
    }),
    prisma.despacho.findMany({ select: { id: true, name: true, precioMensualCentavos: true }, orderBy: { name: "asc" } }),
    prisma.costEvent.groupBy({
      by: ["companyId"],
      where: { occurredAt: { gte: from, lt: to }, companyId: { not: null } },
      _sum: { costoMicroUsd: true },
      _count: { _all: true },
    }),
    // Desglose por categoría (LLM / SYNTAGE / FACTURAPI) por empresa — base de
    // precios. unidades nos da, para FACTURAPI, el conteo de timbres.
    prisma.costEvent.groupBy({
      by: ["companyId", "categoria"],
      where: { occurredAt: { gte: from, lt: to }, companyId: { not: null } },
      _sum: { costoMicroUsd: true, unidades: true },
    }),
    prisma.costEvent.groupBy({
      by: ["despachoId"],
      where: { occurredAt: { gte: from, lt: to }, companyId: null, despachoId: { not: null } },
      _sum: { costoMicroUsd: true },
    }),
  ]);

  const microPorEmpresa = new Map(porEmpresa.map((g) => [g.companyId, { micro: g._sum.costoMicroUsd ?? 0, eventos: g._count._all }]));
  const catMicroPorEmpresa = new Map<string, { LLM: number; SYNTAGE: number; FACTURAPI: number; timbres: number }>();
  for (const g of porEmpresaCategoria) {
    if (!g.companyId) continue;
    const cur = catMicroPorEmpresa.get(g.companyId) ?? { LLM: 0, SYNTAGE: 0, FACTURAPI: 0, timbres: 0 };
    if (g.categoria === "LLM") cur.LLM += g._sum.costoMicroUsd ?? 0;
    else if (g.categoria === "SYNTAGE") cur.SYNTAGE += g._sum.costoMicroUsd ?? 0;
    else if (g.categoria === "FACTURAPI") {
      cur.FACTURAPI += g._sum.costoMicroUsd ?? 0;
      cur.timbres += g._sum.unidades ?? 0;
    }
    catMicroPorEmpresa.set(g.companyId, cur);
  }
  const overheadMicroPorDespacho = new Map(overheadDespacho.map((g) => [g.despachoId, g._sum.costoMicroUsd ?? 0]));

  const empresas: RentabilidadEmpresa[] = companies.map((c) => {
    const agg = microPorEmpresa.get(c.id);
    const cat = catMicroPorEmpresa.get(c.id) ?? { LLM: 0, SYNTAGE: 0, FACTURAPI: 0, timbres: 0 };
    const costoCentavos = microUsdACentavosMxn(agg?.micro ?? 0, fixUsado);
    const precio = c.precioMensualCentavos ?? null;
    const margen = precio != null ? precio - costoCentavos : null;
    return {
      companyId: c.id,
      razonSocial: c.razonSocial,
      rfc: c.rfc,
      despachoId: c.despachoId,
      plan: c.tier,
      precioMensualCentavos: precio,
      costoCentavos,
      costoSyntageCentavos: microUsdACentavosMxn(cat.SYNTAGE, fixUsado),
      costoLlmCentavos: microUsdACentavosMxn(cat.LLM, fixUsado),
      costoFacturapiCentavos: microUsdACentavosMxn(cat.FACTURAPI, fixUsado),
      timbresMes: cat.timbres,
      eventos: agg?.eventos ?? 0,
      margenCentavos: margen,
      margenPct: precio && precio > 0 && margen != null ? margen / precio : null,
    };
  });

  const despachosOut: RentabilidadDespacho[] = despachos.map((d) => {
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

  const totalCostoCentavos =
    empresas.reduce((s, e) => s + e.costoCentavos, 0) + despachosOut.reduce((s, d) => s + d.overheadCentavos, 0);

  return {
    periodo: `${year}-${pad(month)}`,
    fixMxnPorUsd: fixUsado,
    fixReal: fix != null,
    totalCostoCentavos,
    totalSyntageCentavos: empresas.reduce((s, e) => s + e.costoSyntageCentavos, 0),
    totalLlmCentavos: empresas.reduce((s, e) => s + e.costoLlmCentavos, 0),
    totalFacturapiCentavos: empresas.reduce((s, e) => s + e.costoFacturapiCentavos, 0),
    empresas,
    despachos: despachosOut,
  };
}
