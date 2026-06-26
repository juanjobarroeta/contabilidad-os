// Detalle por empresa para el dashboard de Rentabilidad (drill-down): el costo
// del MES desglosado por subtipo (qué movió el $), junto con la COBERTURA de
// datos actual (qué extracciones aterrizaron de verdad). Esto último responde
// "¿se jaló el histórico?" sin tener que mirar a Syntage: cruza el último
// disparo (CostEvent) contra la evidencia persistida (snapshots/declaraciones).

import { prisma } from "@/lib/prisma";
import { microUsdACentavosMxn } from "./rates";
import { fetchTipoCambioFix } from "@/lib/fiscal/banxico";
import { EXTRACTORES_PROVISION, type ExtractorProvision } from "@/lib/fiscal/cumplimiento/syntage/cadencia";

export interface CostoSubtipo {
  subtipo: string;
  categoria: string;
  eventos: number;
  unidades: number;
  costoCentavos: number;
  ultimoAt: string | null;
}
export interface CoberturaExtractor {
  extractor: ExtractorProvision;
  /** Último disparo medido en CostEvent (cualquier periodo). */
  ultimaAt: string | null;
  /** ¿El dato derivado ya está en la BD? false = se cobró pero nunca aterrizó. */
  datoPresente: boolean;
}
export interface CoberturaCompliance {
  tipo: string; // SAT_OPINION | CSF | IMSS_OPINION
  resultado: string | null;
  fetchedAt: string | null;
}
export interface CoberturaDeclaracion {
  tipo: string;
  total: number;
  periodos: string[]; // los más recientes (hasta 12)
}
export interface EmpresaDetalle {
  companyId: string;
  razonSocial: string;
  rfc: string;
  periodo: string;
  fixMxnPorUsd: number;
  fixReal: boolean;
  totalCentavos: number;
  costos: CostoSubtipo[];
  extracciones: CoberturaExtractor[];
  compliance: CoberturaCompliance[];
  declaraciones: CoberturaDeclaracion[];
}

const pad = (n: number) => String(n).padStart(2, "0");

export async function computeEmpresaDetalle(
  companyId: string,
  year: number,
  month: number,
): Promise<EmpresaDetalle | null> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, razonSocial: true, rfc: true },
  });
  if (!company) return null;

  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month, 1);
  const fix = (await fetchTipoCambioFix())?.valor ?? null;
  const fixUsado = fix ?? 20;

  const [
    porSubtipo,
    extraccionesRaw,
    opinion,
    csf,
    imss,
    declaracionesRaw,
  ] = await Promise.all([
    // Costo del mes desglosado por subtipo (qué movió el $).
    prisma.costEvent.groupBy({
      by: ["subtipo", "categoria"],
      where: { companyId, occurredAt: { gte: from, lt: to } },
      _sum: { costoMicroUsd: true, unidades: true },
      _count: { _all: true },
      _max: { occurredAt: true },
    }),
    // Último disparo de cada extractor Syntage (cualquier periodo) — cobertura.
    prisma.costEvent.groupBy({
      by: ["subtipo"],
      where: { companyId, categoria: "SYNTAGE" },
      _max: { occurredAt: true },
    }),
    prisma.complianceSnapshot.findFirst({
      where: { companyId, tipo: "SAT_OPINION" },
      orderBy: { fetchedAt: "desc" },
      select: { resultado: true, fetchedAt: true },
    }),
    prisma.complianceSnapshot.findFirst({
      where: { companyId, tipo: "CSF" },
      orderBy: { fetchedAt: "desc" },
      select: { resultado: true, fetchedAt: true },
    }),
    prisma.complianceSnapshot.findFirst({
      where: { companyId, tipo: "IMSS_OPINION" },
      orderBy: { fetchedAt: "desc" },
      select: { resultado: true, fetchedAt: true },
    }),
    prisma.taxDeclaration.findMany({
      where: { companyId },
      select: { tipo: true, periodo: true },
      orderBy: { periodo: "desc" },
    }),
  ]);

  const costos: CostoSubtipo[] = porSubtipo
    .map((g) => ({
      subtipo: g.subtipo,
      categoria: g.categoria,
      eventos: g._count._all,
      unidades: g._sum.unidades ?? 0,
      costoCentavos: microUsdACentavosMxn(g._sum.costoMicroUsd ?? 0, fixUsado),
      ultimoAt: g._max.occurredAt?.toISOString() ?? null,
    }))
    .sort((a, b) => b.costoCentavos - a.costoCentavos);

  const ultimaExtr = new Map<string, Date | null>();
  for (const r of extraccionesRaw) {
    ultimaExtr.set(r.subtipo.replace("syntage.extraction.", ""), r._max.occurredAt ?? null);
  }

  // ¿Aterrizó el dato derivado de cada extractor? (mismo mapeo que provision).
  const [hayAnual, hayMensual] = [
    declaracionesRaw.some((d) => d.tipo === "DECLARACION_ANUAL"),
    declaracionesRaw.some((d) => d.tipo === "IVA_MENSUAL" || d.tipo === "ISR_PROVISIONAL"),
  ];
  const presente: Record<ExtractorProvision, boolean> = {
    tax_compliance: !!opinion,
    tax_status: !!csf,
    annual_tax_return: hayAnual,
    monthly_tax_return: hayMensual,
  };
  const extracciones: CoberturaExtractor[] = EXTRACTORES_PROVISION.map((ex) => ({
    extractor: ex,
    ultimaAt: ultimaExtr.get(ex)?.toISOString() ?? null,
    datoPresente: presente[ex],
  }));

  const compliance: CoberturaCompliance[] = [
    { tipo: "SAT_OPINION", resultado: opinion?.resultado ?? null, fetchedAt: opinion?.fetchedAt.toISOString() ?? null },
    { tipo: "CSF", resultado: csf?.resultado ?? null, fetchedAt: csf?.fetchedAt.toISOString() ?? null },
    { tipo: "IMSS_OPINION", resultado: imss?.resultado ?? null, fetchedAt: imss?.fetchedAt.toISOString() ?? null },
  ];

  const porTipo = new Map<string, string[]>();
  for (const d of declaracionesRaw) {
    const arr = porTipo.get(d.tipo) ?? [];
    arr.push(d.periodo);
    porTipo.set(d.tipo, arr);
  }
  const declaraciones: CoberturaDeclaracion[] = [...porTipo.entries()].map(([tipo, periodos]) => ({
    tipo,
    total: periodos.length,
    periodos: periodos.slice(0, 12),
  }));

  return {
    companyId: company.id,
    razonSocial: company.razonSocial,
    rfc: company.rfc,
    periodo: `${year}-${pad(month)}`,
    fixMxnPorUsd: fixUsado,
    fixReal: fix != null,
    totalCentavos: costos.reduce((s, c) => s + c.costoCentavos, 0),
    costos,
    extracciones,
    compliance,
    declaraciones,
  };
}
