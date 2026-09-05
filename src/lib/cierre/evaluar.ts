// ─────────────────────────────────────────────────────────────────────────────
// EVALUAR Y PERSISTIR EL CIERRE DE UN PERIODO.
//
//   cargarHechosCierre  → reúne lo que los motores ya calculan (ce-readiness,
//                         checklist-declaracion) más conteos baratos, en una
//                         pasada paralela. Ninguna cifra se calcula aquí.
//   evaluarCierre       → decidirPasos(hechos) y, si se pide, sincroniza con
//                         CierrePeriodo/PasoCierre.
//   sincronizarCierre   → upsert por paso; un paso CONFIRMADO/OMITIDO cuya
//                         evidencia cambió vuelve a REVISAR (bitácora).
//   confirmarPaso / omitirPaso / reabrirPaso → la decisión humana. Son la
//                         ÚNICA vía por la que un paso se cierra; el copiloto
//                         sólo las propone (pending-action) y el humano toca.
//
// Sin auth: el llamador autoriza `companyId` antes (ver gate.ts).
// ─────────────────────────────────────────────────────────────────────────────

import type { EstadoPasoCierre, Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { registrarBitacora } from "../audit";
import { evaluarReadinessCE, regimenRequiereBalance } from "../contabilidad/ce-readiness";
import { checklistDeclaracion } from "../fiscal/checklist-declaracion";
import {
  decidirPasos,
  definicionPaso,
  periodoStr,
  type ClavePasoCierre,
  type ContextoEmpresa,
  type ExtrasCierre,
  type HechosCierre,
  type PasoEvaluado,
} from "./workflow";

export interface PasoConDecision extends PasoEvaluado {
  estado: EstadoPasoCierre;
  confirmadoAt: string | null;
  confirmadoByUserId: string | null;
  nota: string | null;
}

export interface CierreEvaluado {
  companyId: string;
  year: number;
  month: number;
  periodo: string;
  cierreId: string | null;
  responsableUserId: string | null;
  conversationId: string | null;
  cerradoAt: string | null;
  pasos: PasoConDecision[];
  resumen: {
    total: number;
    aplican: number;
    listos: number;
    atencion: number;
    bloquean: number;
    confirmados: number;
    /** Todos los pasos que requieren confirmación están CONFIRMADO u OMITIDO. */
    completo: boolean;
  };
}

/** Reúne los hechos del periodo. Una fuente por cifra, para que el hash no oscile. */
export async function cargarHechosCierre(
  companyId: string,
  year: number,
  month: number,
  hoy: Date = new Date()
): Promise<HechosCierre> {
  const periodo = periodoStr(year, month);
  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month, 1);

  const [
    company,
    readiness,
    checklist,
    cfdiFaltantes,
    cuentas,
    movimientosPorCuenta,
    firmas,
    empleadosActivos,
    empleadosConRecibo,
    idsePendientes,
    hallazgosCriticos,
    hallazgosEfos,
    federal,
    diotObligacion,
  ] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { regimenFiscal: true } }),
    evaluarReadinessCE(companyId, year, month, hoy).catch((e) => {
      console.error("[cierre] readiness falló:", companyId, e instanceof Error ? e.message : e);
      return null;
    }),
    checklistDeclaracion(companyId, year, month, hoy).catch((e) => {
      console.error("[cierre] checklist falló:", companyId, e instanceof Error ? e.message : e);
      return null;
    }),
    prisma.cfdiFaltante.count({ where: { companyId, fecha: { gte: from, lt: to } } }),
    prisma.bankAccount.findMany({ where: { companyId }, select: { id: true } }),
    prisma.bankTransaction.groupBy({
      by: ["bankAccountId"],
      where: { companyId, fecha: { gte: from, lt: to } },
      _count: { _all: true },
    }),
    prisma.conciliacionBancaria.count({ where: { companyId, year, month, conciliadoAt: { not: null } } }),
    prisma.employee.count({ where: { companyId, isActive: true } }),
    prisma.payrollItem.findMany({
      where: {
        payrollRun: { companyId, status: { in: ["STAMPED", "PAID"] }, fechaPago: { gte: from, lt: to } },
      },
      select: { employeeId: true },
      distinct: ["employeeId"],
    }),
    prisma.imssMovimiento.count({ where: { companyId, status: "PENDING" } }),
    prisma.fiscalHallazgo.count({
      where: {
        companyId,
        estado: "ABIERTO",
        severidad: "error",
        NOT: { checkClave: { startsWith: "efos." } },
        OR: [{ posponerHasta: null }, { posponerHasta: { lte: hoy } }],
      },
    }),
    prisma.fiscalHallazgo.count({
      where: {
        companyId,
        estado: "ABIERTO",
        checkClave: { startsWith: "efos." },
        OR: [{ posponerHasta: null }, { posponerHasta: { lte: hoy } }],
      },
    }),
    prisma.taxDeclaration.findFirst({
      where: { companyId, periodo, tipo: { in: ["IVA_MENSUAL", "ISR_PROVISIONAL", "RETENCIONES_ISR"] } },
      orderBy: { tipo: "asc" },
      select: { status: true, _count: { select: { bankTransactions: true } } },
    }),
    prisma.companyObligation.count({ where: { companyId, activa: true, tipo: "DIOT" } }),
  ]);

  const conMovimientos = new Set(movimientosPorCuenta.map((m) => m.bankAccountId));
  const cuentasSinEstado = cuentas.filter((c) => !conMovimientos.has(c.id)).length;
  const conRecibo = new Set(empleadosConRecibo.map((p) => p.employeeId));
  // Empleados activos sin recibo: se cuenta sobre los activos de hoy; si un
  // empleado entró después del mes, el checklist de nómina ya lo contempla.
  const activos = await prisma.employee.findMany({
    where: { companyId, isActive: true },
    select: { id: true },
  });
  const empleadosSinRecibo =
    empleadosActivos === 0 ? 0 : activos.filter((e) => !conRecibo.has(e.id)).length;

  const regimenFiscal = company?.regimenFiscal ?? "";
  const ctx: ContextoEmpresa = {
    regimenFiscal,
    requiereBalance: regimenRequiereBalance(regimenFiscal),
    tieneEmpleados: empleadosActivos > 0 || (checklist?.items.some((i) => i.clave === "nomina" && i.estado !== "no-aplica") ?? false),
    tieneDiot: diotObligacion > 0,
    tieneBanco: cuentas.length > 0 || movimientosPorCuenta.length > 0,
    year,
    month,
  };

  const extras: ExtrasCierre = {
    cfdiFaltantes,
    cuentasBanco: cuentas.length,
    cuentasSinEstado,
    cuentasFirmadas: Math.min(firmas, cuentas.length),
    empleadosActivos,
    empleadosSinRecibo,
    idsePendientes,
    hallazgosCriticos,
    hallazgosEfos,
    pagoConciliado: (federal?._count.bankTransactions ?? 0) > 0,
    declaracionPagada: federal?.status === "PAID",
  };

  return { ctx, hoy, readiness, checklist, extras };
}

/** Evalúa el periodo; con `persistir` sincroniza CierrePeriodo/PasoCierre. */
export async function evaluarCierre(
  companyId: string,
  year: number,
  month: number,
  opts: { hoy?: Date; persistir?: boolean } = {}
): Promise<CierreEvaluado> {
  const hoy = opts.hoy ?? new Date();
  const hechos = await cargarHechosCierre(companyId, year, month, hoy);
  const evaluados = decidirPasos(hechos);
  if (opts.persistir) {
    return sincronizarCierre(companyId, year, month, evaluados);
  }
  const existente = await prisma.cierrePeriodo.findUnique({
    where: { companyId_year_month: { companyId, year, month } },
    include: { pasos: true },
  });
  return armarResultado(companyId, year, month, evaluados, existente);
}

type CierreConPasos = Prisma.CierrePeriodoGetPayload<{ include: { pasos: true } }>;

function armarResultado(
  companyId: string,
  year: number,
  month: number,
  evaluados: PasoEvaluado[],
  cierre: CierreConPasos | null
): CierreEvaluado {
  const porClave = new Map((cierre?.pasos ?? []).map((p) => [p.clave, p]));
  const pasos: PasoConDecision[] = evaluados.map((ev) => {
    const row = porClave.get(ev.clave);
    // Un paso confirmado cuya evidencia cambió se muestra como REVISAR aunque
    // la fila aún no se haya sincronizado (lectura sin persistir).
    let estado: EstadoPasoCierre = row?.estado ?? "PENDIENTE";
    if (row && (estado === "CONFIRMADO" || estado === "OMITIDO") && row.hashConfirmado !== ev.hashEvidencia) {
      estado = "REVISAR";
    }
    return {
      ...ev,
      estado,
      confirmadoAt: row?.confirmadoAt?.toISOString() ?? null,
      confirmadoByUserId: row?.confirmadoByUserId ?? null,
      nota: row?.nota ?? null,
    };
  });
  const aplican = pasos.filter((p) => p.estadoCalculado !== "no_aplica");
  const requieren = aplican.filter((p) => p.requiereConfirmacion);
  return {
    companyId,
    year,
    month,
    periodo: periodoStr(year, month),
    cierreId: cierre?.id ?? null,
    responsableUserId: cierre?.responsableUserId ?? null,
    conversationId: cierre?.conversationId ?? null,
    cerradoAt: cierre?.cerradoAt?.toISOString() ?? null,
    pasos,
    resumen: {
      total: pasos.length,
      aplican: aplican.length,
      listos: aplican.filter((p) => p.estadoCalculado === "listo").length,
      atencion: aplican.filter((p) => p.estadoCalculado === "atencion").length,
      bloquean: aplican.filter((p) => p.estadoCalculado === "bloquea").length,
      confirmados: requieren.filter((p) => p.estado === "CONFIRMADO" || p.estado === "OMITIDO").length,
      completo: requieren.length > 0 && requieren.every((p) => p.estado === "CONFIRMADO" || p.estado === "OMITIDO"),
    },
  };
}

/**
 * Upsert del cierre y de cada paso. Un paso CONFIRMADO/OMITIDO cuya evidencia
 * ya no coincide con la confirmada pasa a REVISAR y queda en bitácora.
 */
export async function sincronizarCierre(
  companyId: string,
  year: number,
  month: number,
  evaluados: PasoEvaluado[]
): Promise<CierreEvaluado> {
  const cierre = await prisma.cierrePeriodo.upsert({
    where: { companyId_year_month: { companyId, year, month } },
    create: { companyId, year, month, snapshot: evaluados as unknown as Prisma.InputJsonValue },
    update: { snapshot: evaluados as unknown as Prisma.InputJsonValue },
    include: { pasos: true },
  });
  const porClave = new Map(cierre.pasos.map((p) => [p.clave, p]));
  const revisados: string[] = [];

  for (const ev of evaluados) {
    const row = porClave.get(ev.clave);
    const hechos = ev.hechos as Prisma.InputJsonValue;
    if (!row) {
      await prisma.pasoCierre.create({
        data: {
          cierreId: cierre.id,
          clave: ev.clave,
          estadoCalculado: ev.estadoCalculado,
          detalle: ev.detalle,
          hechos,
          hashEvidencia: ev.hashEvidencia,
        },
      });
      continue;
    }
    const decidido = row.estado === "CONFIRMADO" || row.estado === "OMITIDO";
    const cambio = decidido && row.hashConfirmado !== ev.hashEvidencia;
    if (cambio) revisados.push(ev.clave);
    if (
      row.estadoCalculado === ev.estadoCalculado &&
      row.hashEvidencia === ev.hashEvidencia &&
      row.detalle === ev.detalle &&
      !cambio
    ) {
      continue;
    }
    await prisma.pasoCierre.update({
      where: { id: row.id },
      data: {
        estadoCalculado: ev.estadoCalculado,
        detalle: ev.detalle,
        hechos,
        hashEvidencia: ev.hashEvidencia,
        ...(cambio ? { estado: "REVISAR" as const } : {}),
      },
    });
  }

  if (revisados.length > 0) {
    registrarBitacora({
      companyId,
      accion: "cierre.paso.revisar",
      entidad: "CierrePeriodo",
      entidadId: cierre.id,
      detalle: { periodo: periodoStr(year, month), pasos: revisados },
    });
  }

  const fresco = await prisma.cierrePeriodo.findUniqueOrThrow({
    where: { id: cierre.id },
    include: { pasos: true },
  });
  return armarResultado(companyId, year, month, evaluados, fresco);
}

// ── La decisión humana ───────────────────────────────────────────────────────

export type MotivoRechazo = "hash_cambio" | "bloqueado" | "no_aplica" | "sin_nota" | "no_existe";

export type ResultadoDecision =
  | { ok: true; cierre: CierreEvaluado }
  | { ok: false; motivo: MotivoRechazo; error: string; cierre?: CierreEvaluado };

interface ArgsDecision {
  companyId: string;
  year: number;
  month: number;
  clave: ClavePasoCierre;
  userId: string;
  /** Hash que el humano vio al decidir; si ya no coincide, se rechaza (409). */
  hashEsperado?: string | null;
  nota?: string | null;
  req?: Request | null;
}

async function decidir(
  accion: "confirmar" | "omitir" | "reabrir",
  a: ArgsDecision
): Promise<ResultadoDecision> {
  // Siempre sobre evidencia FRESCA: se re-evalúa antes de aceptar.
  const cierre = await evaluarCierre(a.companyId, a.year, a.month, { persistir: true });
  const paso = cierre.pasos.find((p) => p.clave === a.clave);
  if (!paso || !cierre.cierreId) {
    return { ok: false, motivo: "no_existe", error: "El paso no existe en este periodo.", cierre };
  }
  if (paso.estadoCalculado === "no_aplica") {
    return { ok: false, motivo: "no_aplica", error: "Este paso no aplica a la empresa en este periodo.", cierre };
  }
  if (accion !== "reabrir") {
    if (a.hashEsperado && a.hashEsperado !== paso.hashEvidencia) {
      return {
        ok: false,
        motivo: "hash_cambio",
        error: "La evidencia del paso cambió desde que la viste. Revísala de nuevo antes de decidir.",
        cierre,
      };
    }
    if (accion === "confirmar" && (paso.estadoCalculado === "bloquea" || paso.estadoCalculado === "espera")) {
      return {
        ok: false,
        motivo: "bloqueado",
        error:
          paso.estadoCalculado === "espera"
            ? "Un paso anterior bloquea éste; resuélvelo primero."
            : "El paso tiene un bloqueo activo; no se puede confirmar hasta resolverlo.",
        cierre,
      };
    }
    if (accion === "omitir" && !a.nota?.trim()) {
      return { ok: false, motivo: "sin_nota", error: "Para omitir un paso hay que dejar el motivo.", cierre };
    }
  }

  const estado: EstadoPasoCierre = accion === "confirmar" ? "CONFIRMADO" : accion === "omitir" ? "OMITIDO" : "PENDIENTE";
  const ahora = new Date();
  await prisma.$transaction([
    prisma.pasoCierre.update({
      where: { cierreId_clave: { cierreId: cierre.cierreId, clave: a.clave } },
      data:
        accion === "reabrir"
          ? { estado, confirmadoAt: null, confirmadoByUserId: null, hashConfirmado: null, nota: a.nota?.trim() || null }
          : {
              estado,
              confirmadoAt: ahora,
              confirmadoByUserId: a.userId,
              hashConfirmado: paso.hashEvidencia,
              nota: a.nota?.trim() || null,
            },
    }),
    // El primero que decide se vuelve responsable del cierre (recibe los avisos).
    prisma.cierrePeriodo.updateMany({
      where: { id: cierre.cierreId, responsableUserId: null },
      data: { responsableUserId: a.userId },
    }),
  ]);

  registrarBitacora({
    companyId: a.companyId,
    userId: a.userId,
    accion: `cierre.paso.${accion}`,
    entidad: "PasoCierre",
    entidadId: cierre.cierreId,
    detalle: {
      periodo: cierre.periodo,
      paso: a.clave,
      estadoCalculado: paso.estadoCalculado,
      detalleMotor: paso.detalle,
      hash: paso.hashEvidencia,
      nota: a.nota?.trim() || null,
    },
    req: a.req ?? null,
  });

  const fresco = await prisma.cierrePeriodo.findUniqueOrThrow({
    where: { id: cierre.cierreId },
    include: { pasos: true },
  });
  const evaluados: PasoEvaluado[] = cierre.pasos.map(({ estado: _e, confirmadoAt: _c, confirmadoByUserId: _u, nota: _n, ...ev }) => ev);
  return { ok: true, cierre: armarResultado(a.companyId, a.year, a.month, evaluados, fresco) };
}

export function confirmarPaso(a: ArgsDecision): Promise<ResultadoDecision> {
  definicionPaso(a.clave);
  return decidir("confirmar", a);
}
export function omitirPaso(a: ArgsDecision): Promise<ResultadoDecision> {
  definicionPaso(a.clave);
  return decidir("omitir", a);
}
export function reabrirPaso(a: ArgsDecision): Promise<ResultadoDecision> {
  definicionPaso(a.clave);
  return decidir("reabrir", a);
}
