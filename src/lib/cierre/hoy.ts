// ─────────────────────────────────────────────────────────────────────────────
// «HOY» — lo que el contador tiene que hacer hoy en sus RFCs, leído de lo que
// el pase diario ya persistió (PasoCierre). Cero motores en abanico: la regla
// de inicio/cola.ts. El ranking es PURO para probarlo sin base.
// ─────────────────────────────────────────────────────────────────────────────

import type { EstadoPasoCierre } from "@prisma/client";
import { prisma } from "../prisma";
import { effectiveCierrePlan, planIncluyeCierreGuiado } from "../planes";
import { ORDEN_PASOS, definicionPaso, esClavePaso, periodoStr, type ClavePasoCierre, type EstadoCalculado } from "./workflow";
import { etiquetaPeriodo } from "./plantillas";

export interface FilaHoy {
  companyId: string;
  empresa: string;
  rfc: string;
  year: number;
  month: number;
  periodoLabel: string;
  paso: ClavePasoCierre;
  tituloPaso: string;
  estadoCalculado: EstadoCalculado;
  estado: EstadoPasoCierre;
  detalle: string | null;
  /** Sólo en declaración: días a la fecha límite (negativo = vencida). */
  diasRestantes: number | null;
  href: string;
}

export interface ResumenEmpresaHoy {
  companyId: string;
  empresa: string;
  rfc: string;
  year: number;
  month: number;
  periodoLabel: string;
  aplican: number;
  confirmados: number;
  bloquean: number;
  atencion: number;
  href: string;
}

/**
 * Prioridad de una fila (menor = primero): declaración vencida, bloqueos,
 * pasos confirmados que hay que revisar, por vencer, atención; luego el orden
 * del flujo y el periodo más viejo primero. PURA.
 */
export function prioridadHoy(f: FilaHoy): number {
  if (f.paso === "declaracion" && f.diasRestantes != null && f.diasRestantes < 0) return 0;
  if (f.estadoCalculado === "bloquea") return 1;
  if (f.estado === "REVISAR") return 2;
  if (f.paso === "declaracion" && f.diasRestantes != null && f.diasRestantes <= 3) return 3;
  return 4;
}

export function rankHoy(filas: FilaHoy[], max = 20): FilaHoy[] {
  return [...filas]
    .sort((a, b) => {
      const p = prioridadHoy(a) - prioridadHoy(b);
      if (p !== 0) return p;
      const per = a.year * 100 + a.month - (b.year * 100 + b.month);
      if (per !== 0) return per;
      return ORDEN_PASOS.indexOf(a.paso) - ORDEN_PASOS.indexOf(b.paso);
    })
    .slice(0, max);
}

/** Filas de «Hoy» para un conjunto de empresas accesibles (ya autorizadas). */
export async function filasHoy(companyIds: string[]): Promise<{ filas: FilaHoy[]; empresas: ResumenEmpresaHoy[] }> {
  if (companyIds.length === 0) return { filas: [], empresas: [] };
  const companies = await prisma.company.findMany({
    where: { id: { in: companyIds }, isActive: true },
    select: { id: true, razonSocial: true, rfc: true, tier: true, despacho: { select: { defaultTier: true } } },
  });
  const conPlan = companies.filter((c) => planIncluyeCierreGuiado(effectiveCierrePlan(c)));
  if (conPlan.length === 0) return { filas: [], empresas: [] };
  const nombre = new Map(conPlan.map((c) => [c.id, c]));

  const cierres = await prisma.cierrePeriodo.findMany({
    where: { companyId: { in: conPlan.map((c) => c.id) }, cerradoAt: null },
    select: {
      companyId: true,
      year: true,
      month: true,
      snapshot: true,
      pasos: { select: { clave: true, estadoCalculado: true, estado: true, detalle: true } },
    },
    orderBy: [{ year: "asc" }, { month: "asc" }],
  });

  const filas: FilaHoy[] = [];
  const empresas: ResumenEmpresaHoy[] = [];
  for (const c of cierres) {
    const emp = nombre.get(c.companyId);
    if (!emp) continue;
    const snapshot = (c.snapshot as Array<{ clave: string; diasRestantes?: number; requiereConfirmacion?: boolean }> | null) ?? [];
    const diasDecl = snapshot.find((p) => p.clave === "declaracion")?.diasRestantes ?? null;
    const base = {
      companyId: c.companyId,
      empresa: emp.razonSocial,
      rfc: emp.rfc,
      year: c.year,
      month: c.month,
      periodoLabel: etiquetaPeriodo(c.year, c.month),
    };
    let aplican = 0, confirmados = 0, bloquean = 0, atencion = 0;
    for (const p of c.pasos) {
      if (!esClavePaso(p.clave)) continue;
      const ec = p.estadoCalculado as EstadoCalculado;
      if (ec === "no_aplica") continue;
      const def = definicionPaso(p.clave);
      if (def.requiereConfirmacion) {
        aplican++;
        if (p.estado === "CONFIRMADO" || p.estado === "OMITIDO") confirmados++;
      }
      if (ec === "bloquea") bloquean++;
      if (ec === "atencion") atencion++;
      const pendiente = ec === "bloquea" || ec === "atencion" || p.estado === "REVISAR";
      if (!pendiente) continue;
      filas.push({
        ...base,
        paso: p.clave,
        tituloPaso: def.titulo,
        estadoCalculado: ec,
        estado: p.estado,
        detalle: p.detalle,
        diasRestantes: p.clave === "declaracion" ? diasDecl : null,
        href: `/cierre?y=${c.year}&m=${c.month}&paso=${p.clave}`,
      });
    }
    empresas.push({ ...base, aplican, confirmados, bloquean, atencion, href: `/cierre?y=${c.year}&m=${c.month}` });
  }
  return { filas: rankHoy(filas), empresas };
}

export { periodoStr };
