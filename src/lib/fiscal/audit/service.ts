// ─────────────────────────────────────────────────────────────────────────────
// Audit service — the integration layer between the pure auditor and the app.
// Loads a company's CFDIs, runs auditar(), and persists Hallazgos idempotently.
// The cron route calls runAuditForCompany per company.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { construirContexto } from "@/lib/fiscal/rules";
import {
  agregarNominaPorEmpleado,
  auditarIsn,
  empleadoNominaDesde,
  type EmpleadoNomina,
  type FuenteBase,
} from "@/lib/fiscal/isn";
import { auditar } from "./run";
import type { CfdiNormalizado, Direccion, Hallazgo } from "./types";

/** Stable identity for a finding so re-runs upsert in place. */
export function dedupeKey(h: Pick<Hallazgo, "checkClave" | "referencias">): string {
  return `${h.checkClave}|${[...h.referencias].sort().join(",")}`;
}

/**
 * Load a company's CFDIs as normalized rows the auditor understands. Only I/E
 * comprobantes (INGRESO=emitida, EGRESO=recibida); cancelled CFDIs excluded.
 */
export async function loadCompanyCfdis(companyId: string): Promise<CfdiNormalizado[]> {
  const invoices = await prisma.invoice.findMany({
    where: { companyId, tipo: { in: ["INGRESO", "EGRESO"] }, status: { not: "CANCELLED" } },
    select: {
      id: true,
      tipo: true,
      fecha: true,
      formaPago: true,
      total: true,
      moneda: true,
      tipoCambio: true,
      items: { select: { claveProdServ: true, descripcion: true } },
      taxes: { select: { tipo: true, importe: true, retencion: true } },
    },
  });

  return invoices.map((inv): CfdiNormalizado => {
    const direccion: Direccion = inv.tipo === "INGRESO" ? "EMITIDA" : "RECIBIDA";
    const ivaTrasladado = inv.taxes
      .filter((t) => t.tipo === "IVA" && !t.retencion)
      .reduce((s, t) => s + t.importe, 0);
    return {
      id: inv.id,
      direccion,
      fecha: inv.fecha.toISOString().slice(0, 10),
      formaPago: inv.formaPago,
      total: inv.total,
      items: inv.items.map((i) => ({ claveProdServ: i.claveProdServ, descripcion: i.descripcion })),
      ivaTrasladado: ivaTrasladado > 0 ? ivaTrasladado : undefined,
      moneda: inv.moneda,
      tipoCambio: inv.tipoCambio,
    };
  });
}

/**
 * Load the ISN base for the month of `fechaIso`: prefer real payroll
 * (PayrollItem.totalPercepciones from non-DRAFT runs paid that month), and fall
 * back to the active-roster salary estimate when no payroll exists in-app.
 */
export async function cargarNominaParaIsn(
  companyId: string,
  fechaIso: string,
): Promise<{ empleados: EmpleadoNomina[]; fuente: FuenteBase }> {
  const d = new Date(fechaIso);
  const inicio = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const fin = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));

  const runs = await prisma.payrollRun.findMany({
    where: { companyId, status: { not: "DRAFT" }, fechaPago: { gte: inicio, lt: fin } },
    select: {
      items: {
        select: {
          employeeId: true,
          totalPercepciones: true,
          employee: { select: { claveEntFed: true } },
        },
      },
    },
  });

  const items = runs
    .flatMap((r) => r.items)
    .map((i) => ({
      employeeId: i.employeeId,
      claveEntFed: i.employee.claveEntFed,
      totalPercepciones: i.totalPercepciones,
    }));

  if (items.length > 0) {
    return { empleados: agregarNominaPorEmpleado(items), fuente: "payroll" };
  }

  const empleados = await prisma.employee.findMany({
    where: { companyId, isActive: true },
    select: { id: true, salarioDiario: true, claveEntFed: true, isActive: true },
  });
  return { empleados: empleados.map(empleadoNominaDesde), fuente: "estimado" };
}

export interface AuditResult {
  companyId: string;
  evaluados: number;
  hallazgos: number;
  nuevos: number;
}

/**
 * Run the auditor for one company and persist its findings. Idempotent: an
 * unchanged finding upserts in place (keeping its `estado`); a finding that no
 * longer fires is auto-resolved.
 */
export async function runAuditForCompany(companyId: string, fechaIso?: string): Promise<AuditResult> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, regimenFiscal: true, actividadEconomica: true, codigoPostal: true },
  });
  if (!company) throw new Error(`Company ${companyId} not found`);

  const fecha = fechaIso ?? new Date().toISOString().slice(0, 10);
  const ctx = construirContexto(company, fecha);

  const cfdis = await loadCompanyCfdis(companyId);
  const { empleados, fuente } = await cargarNominaParaIsn(companyId, fecha);

  const hallazgos = [
    ...auditar(cfdis, ctx),
    ...auditarIsn(empleados, ctx, fuente),
  ];

  const vigentes = new Set<string>();
  let nuevos = 0;

  for (const h of hallazgos) {
    const key = dedupeKey(h);
    vigentes.add(key);
    const res = await prisma.fiscalHallazgo.upsert({
      where: { companyId_dedupeKey: { companyId, dedupeKey: key } },
      create: {
        companyId,
        dedupeKey: key,
        checkClave: h.checkClave,
        severidad: h.severidad,
        mensaje: h.mensaje,
        referencias: h.referencias,
        sugerencia: h.sugerencia,
        fundamentoLey: h.fundamento.ley,
        fundamentoArticulo: h.fundamento.articulo,
        fundamentoFraccion: h.fundamento.fraccion ?? null,
      },
      update: {
        // Refresh the message/severity in case the rule changed; do NOT touch
        // `estado` so a user's RESUELTO/IGNORADO decision survives re-runs.
        severidad: h.severidad,
        mensaje: h.mensaje,
        referencias: h.referencias,
        sugerencia: h.sugerencia,
      },
      select: { createdAt: true, updatedAt: true },
    });
    if (res.createdAt.getTime() === res.updatedAt.getTime()) nuevos++;
  }

  // Auto-resolve previously-open findings that no longer fire.
  const abiertos = await prisma.fiscalHallazgo.findMany({
    where: { companyId, estado: "ABIERTO" },
    select: { id: true, dedupeKey: true },
  });
  const obsoletos = abiertos.filter((a) => !vigentes.has(a.dedupeKey)).map((a) => a.id);
  if (obsoletos.length > 0) {
    await prisma.fiscalHallazgo.updateMany({
      where: { id: { in: obsoletos } },
      data: { estado: "RESUELTO" },
    });
  }

  return { companyId, evaluados: cfdis.length, hallazgos: hallazgos.length, nuevos };
}
