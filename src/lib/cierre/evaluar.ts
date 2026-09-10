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
import { estadoApertura } from "../fiscal/apertura";
import {
  resolverEstadoCierre,
  type EstadoCierreCanonico,
  type EstadoContableCierre,
} from "./estado-canonico";
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

// ── Memo del motor, por proceso ──────────────────────────────────────────────
// Abrir un paso disparaba la MISMA evaluación cuatro veces: /api/cierre/estado
// al cargar la pantalla, /api/cierre/paso/resumen al abrir el paso, otra en
// cada turno del chat (el bloque del cierre viaja en el prompt) y una más por
// cada query_cierre_* que el copiloto llamara. Cada una son tres motores
// (readiness, checklist, apertura) y decenas de consultas: por eso «va lento».
//
// Se memoiza SÓLO la salida del motor (estados y cifras calculadas). La
// decisión humana (PasoCierre) se lee siempre de la base, así que confirmar un
// paso se ve al instante. Quien necesita evidencia fresca —la decisión del
// humano, el pase diario— pide `fresco: true` y no acepta memo.
const VENTANA_MEMO_MS = 45_000;
const MAX_MEMO = 300;
const memoMotor = new Map<string, { at: number; pasos: PasoEvaluado[] }>();

function claveMemo(companyId: string, year: number, month: number): string {
  return `${companyId}|${year}|${month}`;
}

/** Olvida lo memoizado (un dato del cierre cambió). Sin periodo, toda la empresa. */
export function invalidarCierre(companyId: string, year?: number, month?: number): void {
  if (year && month) {
    memoMotor.delete(claveMemo(companyId, year, month));
    return;
  }
  for (const k of [...memoMotor.keys()]) if (k.startsWith(`${companyId}|`)) memoMotor.delete(k);
}

async function motorDelPeriodo(
  companyId: string,
  year: number,
  month: number,
  opts: { hoy?: Date; fresco?: boolean }
): Promise<PasoEvaluado[]> {
  // Con `hoy` explícito (fixtures, una corrida con otra fecha) no se memoiza:
  // la memo es para «ahora».
  const memoizable = !opts.hoy;
  const clave = claveMemo(companyId, year, month);
  if (memoizable && !opts.fresco) {
    const hit = memoMotor.get(clave);
    if (hit && Date.now() - hit.at < VENTANA_MEMO_MS) return hit.pasos;
  }
  const hechos = await cargarHechosCierre(companyId, year, month, opts.hoy ?? new Date());
  const pasos = decidirPasos(hechos);
  if (memoizable) {
    // Sin LRU: al llenarse se vacía entera. Es una caché de latencia, no de verdad.
    if (memoMotor.size >= MAX_MEMO) memoMotor.clear();
    memoMotor.set(clave, { at: Date.now(), pasos });
  }
  return pasos;
}

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
  /** Estado persistido del ledger, separado de la fase operativa. */
  accountingStatus: EstadoContableCierre | null;
  /** Única precedencia para UI, API, pase diario y compuertas. */
  estado: EstadoCierreCanonico;
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
    activos,
    empleadosConRecibo,
    idsePendientes,
    hallazgosCriticos,
    hallazgosEfos,
    federal,
    diotObligacion,
    cierreBanco,
    apertura,
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
    prisma.employee.findMany({ where: { companyId, isActive: true }, select: { id: true } }),
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
    prisma.cierrePeriodo.findUnique({
      where: { companyId_year_month: { companyId, year, month } },
      select: { sinActividadBancariaAt: true },
    }),
    // El punto de partida CON la procedencia de cada dato: distingue un cero
    // capturado de un «no hay dato». Sin esto el copiloto afirmaba «saldo a
    // favor inicial $0» sin saber si alguien lo había revisado.
    estadoApertura(companyId, hoy).catch((e) => {
      console.error("[cierre] apertura falló:", companyId, e instanceof Error ? e.message : e);
      return null;
    }),
  ]);

  const conMovimientos = new Set(movimientosPorCuenta.map((m) => m.bankAccountId));
  const cuentasSinEstado = cuentas.filter((c) => !conMovimientos.has(c.id)).length;
  const conRecibo = new Set(empleadosConRecibo.map((p) => p.employeeId));
  // Empleados activos sin recibo: se cuenta sobre los activos de hoy; si un
  // empleado entró después del mes, el checklist de nómina ya lo contempla.
  // (La lista de activos ya viene de la pasada paralela: antes se pedía dos
  // veces, una para contar y otra para restar, y la segunda iba en serie.)
  const empleadosActivos = activos.length;
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
    sinActividadBancariaConfirmada:
      movimientosPorCuenta.length === 0 && cierreBanco?.sinActividadBancariaAt != null,
    empleadosActivos,
    empleadosSinRecibo,
    idsePendientes,
    hallazgosCriticos,
    hallazgosEfos,
    pagoConciliado: (federal?._count.bankTransactions ?? 0) > 0,
    declaracionPagada: federal?.status === "PAID",
    apertura: apertura
      ? {
          confirmada: apertura.confirmada,
          confirmadaAt: apertura.confirmadaAt,
          primerPeriodo: apertura.primerPeriodo,
          periodoAnterior: apertura.periodoAnterior,
          ivaSaldoFavor: {
            valor: apertura.ivaSaldoFavor.valor,
            fuente: apertura.ivaSaldoFavor.fuente.tipo,
            etiqueta: apertura.ivaSaldoFavor.fuente.etiqueta,
            referencia: apertura.ivaSaldoFavor.fuente.referencia,
          },
          coeficiente: {
            aplica: apertura.coeficiente.aplica,
            valor: apertura.coeficiente.valor,
            anio: apertura.coeficiente.anio,
            fuente: apertura.coeficiente.fuente.tipo,
            etiqueta: apertura.coeficiente.fuente.etiqueta,
            referencia: apertura.coeficiente.fuente.referencia,
          },
          perdidaPendiente: {
            aplica: apertura.perdidaPendiente.aplica,
            valor: apertura.perdidaPendiente.valor,
            ejercicio: apertura.perdidaPendiente.ejercicio,
            fuente: apertura.perdidaPendiente.fuente.tipo,
            etiqueta: apertura.perdidaPendiente.fuente.etiqueta,
            referencia: apertura.perdidaPendiente.fuente.referencia,
          },
          perdidasPorAmortizar: apertura.perdidasPorAmortizar.length,
          pagosProvisionales: {
            total: apertura.pagosProvisionalesEjercicio.length,
            conAcuse: apertura.pagosProvisionalesEjercicio.filter((p) => p.fuente.tipo === "acuse").length,
          },
          sincronizacion: {
            periodosCubiertos: apertura.sincronizacion.periodosCubiertos,
            periodosTotales: apertura.sincronizacion.periodosTotales,
            faltantes: apertura.sincronizacion.faltantes.length,
          },
          anualAnterior: apertura.anualAnterior
            ? {
                ejercicio: apertura.anualAnterior.ejercicio,
                presentadaEl: apertura.anualAnterior.presentadaEl,
                isrIngresos: apertura.anualAnterior.isrIngresos,
                isrDeducciones: apertura.anualAnterior.isrDeducciones,
                isrBaseGravable: apertura.anualAnterior.isrBaseGravable,
                isrCoeficienteUtilidad: apertura.anualAnterior.isrCoeficienteUtilidad,
                isrPerdidaPendiente: apertura.anualAnterior.isrPerdidaPendiente,
              }
            : null,
        }
      : null,
  };

  return { ctx, hoy, readiness, checklist, extras };
}

/**
 * Evalúa el periodo; con `persistir` sincroniza CierrePeriodo/PasoCierre.
 * Usa la memo del motor salvo que se pida `fresco` (decisión humana, pase diario).
 */
export async function evaluarCierre(
  companyId: string,
  year: number,
  month: number,
  opts: { hoy?: Date; persistir?: boolean; fresco?: boolean } = {}
): Promise<CierreEvaluado> {
  const evaluados = await motorDelPeriodo(companyId, year, month, opts);
  if (opts.persistir) {
    return sincronizarCierre(companyId, year, month, evaluados);
  }
  const [existente, periodoContable] = await Promise.all([
    prisma.cierrePeriodo.findUnique({
      where: { companyId_year_month: { companyId, year, month } },
      include: { pasos: true },
    }),
    prisma.accountingPeriod.findUnique({
      where: { companyId_year_month: { companyId, year, month } },
      select: { status: true },
    }),
  ]);
  return armarResultado(companyId, year, month, evaluados, existente, periodoContable?.status ?? null);
}

type CierreConPasos = Prisma.CierrePeriodoGetPayload<{ include: { pasos: true } }>;

function armarResultado(
  companyId: string,
  year: number,
  month: number,
  evaluados: PasoEvaluado[],
  cierre: CierreConPasos | null,
  accountingStatus: EstadoContableCierre | null
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
  const estado = resolverEstadoCierre({ estadoContable: accountingStatus, pasos });
  return {
    companyId,
    year,
    month,
    periodo: periodoStr(year, month),
    cierreId: cierre?.id ?? null,
    responsableUserId: cierre?.responsableUserId ?? null,
    conversationId: cierre?.conversationId ?? null,
    cerradoAt: cierre?.cerradoAt?.toISOString() ?? null,
    accountingStatus,
    estado,
    pasos,
    resumen: {
      total: pasos.length,
      aplican: aplican.length,
      listos: aplican.filter((p) => p.estadoCalculado === "listo").length,
      atencion: aplican.filter((p) => p.estadoCalculado === "atencion").length,
      bloquean: estado.bloqueos.length,
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
  // Los doce pasos se escribían uno por uno, en serie: doce viajes a la base en
  // cada carga de la pantalla. Se juntan en un createMany y una transacción.
  const nuevos: Prisma.PasoCierreCreateManyInput[] = [];
  const cambios: Prisma.PrismaPromise<unknown>[] = [];

  for (const ev of evaluados) {
    const row = porClave.get(ev.clave);
    const hechos = ev.hechos as Prisma.InputJsonValue;
    if (!row) {
      nuevos.push({
        cierreId: cierre.id,
        clave: ev.clave,
        estadoCalculado: ev.estadoCalculado,
        detalle: ev.detalle,
        hechos,
        hashEvidencia: ev.hashEvidencia,
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
    cambios.push(
      prisma.pasoCierre.update({
        where: { id: row.id },
        data: {
          estadoCalculado: ev.estadoCalculado,
          detalle: ev.detalle,
          hechos,
          hashEvidencia: ev.hashEvidencia,
          ...(cambio ? { estado: "REVISAR" as const } : {}),
        },
      })
    );
  }

  if (nuevos.length > 0) await prisma.pasoCierre.createMany({ data: nuevos, skipDuplicates: true });
  if (cambios.length > 0) await prisma.$transaction(cambios);

  if (revisados.length > 0) {
    registrarBitacora({
      companyId,
      accion: "cierre.paso.revisar",
      entidad: "CierrePeriodo",
      entidadId: cierre.id,
      detalle: { periodo: periodoStr(year, month), pasos: revisados },
    });
  }

  // La fase canónica necesita el estado físico del ledger. Las decisiones
  // humanas no se releen: el paso a REVISAR se deriva del hash vigente.
  const periodoContable = await prisma.accountingPeriod.findUnique({
    where: { companyId_year_month: { companyId, year, month } },
    select: { status: true },
  });
  return armarResultado(companyId, year, month, evaluados, cierre, periodoContable?.status ?? null);
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
  // Siempre sobre evidencia FRESCA: se re-evalúa antes de aceptar, sin memo
  // (el hash es la garantía de que el humano decide sobre lo que vio).
  const cierre = await evaluarCierre(a.companyId, a.year, a.month, { persistir: true, fresco: true });
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
    if (
      accion === "confirmar" &&
      (paso.estadoCalculado === "bloquea" ||
        paso.estadoCalculado === "espera" ||
        paso.estadoCalculado === "sin_datos")
    ) {
      return {
        ok: false,
        motivo: "bloqueado",
        error:
          paso.estadoCalculado === "espera"
            ? "Un paso anterior bloquea éste; resuélvelo primero."
            : paso.estadoCalculado === "sin_datos"
              ? "No hay evidencia suficiente para confirmar este paso. Intenta evaluarlo de nuevo."
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

  if (accion !== "reabrir") {
    // El aviso del pase diario sobre este paso queda accionado (precisión).
    await prisma.cierreAviso.updateMany({
      where: { companyId: a.companyId, periodo: cierre.periodo, paso: a.clave, accionadoAt: null },
      data: { accionadoAt: ahora },
    });
  }

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
  return {
    ok: true,
    cierre: armarResultado(a.companyId, a.year, a.month, evaluados, fresco, cierre.accountingStatus),
  };
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
