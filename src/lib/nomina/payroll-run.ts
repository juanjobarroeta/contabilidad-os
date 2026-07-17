// ─── PayrollRun Batch Orchestrator ───────────────────────────────────────────
// Creates a payroll run for multiple employees, calculates all items, and
// stamps CFDIs in batch with concurrency control.
//
// Designed to handle 1,000+ employees:
// - Calculation: batch DB inserts via createMany
// - Stamping: concurrent with limit (5 at a time), progress tracked on run.
//   La API espera a que el timbrado termine (no responde de inmediato); el
//   avance se registra en extraData.stampedCount por si el cliente consulta.

import { prisma } from "../prisma";
import { calcularNomina, type NominaCalcInput, type NominaCalcResult } from "./calc-nomina";
import { calcularPtu, type PtuEmployeeData } from "./ptu";
import { emitNominaCfdi } from "./emit-nomina";
import { SALARIO_MINIMO_GENERAL, PTU_EXENTO_UMA, UMA_DIARIO, umaDiariaDelEjercicio } from "./constants";
import {
  incidenciasDelPeriodo,
  resumirIncidencias,
  resumenTieneEfecto,
  rangoDelPeriodo,
  diasDelPeriodo,
  type IncidenciasResumen,
} from "./incidencias";
import { motivoTimbradoNoDisponible } from "./timbrado-candado";
import type { PayrollRunType, Employee, Incidencia, Prisma } from "@prisma/client";

// Concurrency limit for Facturapi calls
const STAMP_CONCURRENCY = 5;

export type CreatePayrollRunInput = {
  companyId: string;
  tipo: PayrollRunType;
  periodoInicio: Date;
  periodoFin: Date;
  fechaPago: Date;
  diasPagados: number;
  employeeIds?: string[]; // default = all active employees
  // Extraordinary-type params
  diasAguinaldo?: number;
  fechaCorte?: Date;
  diasVacacionesTomar?: number;
  primaVacacionalPct?: number;
  utilidadFiscalGravable?: number; // for PTU
  topeSalarioPtu?: number;
  // ── Corridas especiales de un toque (aguinaldo / PTU) ──
  /** Ejercicio al que corresponde la prestación (p.ej. aguinaldo 2026, PTU del ejercicio 2025). */
  ejercicio?: number;
  /** Monto total de PTU capturado directamente (renglón de la declaración anual). */
  ptuMontoTotal?: number;
  /** Overrides por empleado del monto de aguinaldo (vista previa editable). */
  aguinaldoMontos?: Record<string, number>;
  /**
   * Asignación final de PTU por empleado (monto y exento), calculada por
   * repartirPtu + ajustes manuales de la vista previa. Cuando se pasa, tiene
   * prioridad sobre el cálculo desde utilidadFiscalGravable.
   */
  ptuAsignaciones?: Record<string, { monto: number; exento: number }>;
};

export type PayrollRunResult = {
  ok: boolean;
  runId?: string;
  itemCount?: number;
  totalPercepciones?: number;
  totalDeducciones?: number;
  totalNeto?: number;
  /** Set cuando el ISR se calculó con tarifa/subsidio sin verificar para el ejercicio. */
  tarifaWarning?: string | null;
  /** Empleados con salario diario por debajo del mínimo general vigente. */
  salarioMinimoWarning?: string | null;
  error?: string;
};

export async function createPayrollRun(input: CreatePayrollRunInput): Promise<PayrollRunResult> {
  // Fetch employees
  const where = {
    companyId: input.companyId,
    isActive: true,
    ...(input.employeeIds ? { id: { in: input.employeeIds } } : {}),
  };
  const employees = await prisma.employee.findMany({ where });

  if (employees.length === 0) {
    return { ok: false, error: "No hay empleados activos para esta corrida" };
  }

  const periodo = `${input.periodoInicio.toISOString().split("T")[0]}/${input.periodoFin.toISOString().split("T")[0]}`;

  // For PTU, pre-calculate the distribution
  let ptuDistribuciones: Map<string, { monto: number; exento: number }> | undefined;
  if (input.tipo === "PTU" && input.ptuAsignaciones) {
    // Asignación ya repartida (repartirPtu + ajustes de la vista previa) —
    // corrida especial de un toque.
    ptuDistribuciones = new Map(Object.entries(input.ptuAsignaciones));
  } else if (input.tipo === "PTU" && input.utilidadFiscalGravable) {
    const ptuEmployees: PtuEmployeeData[] = employees.map((e) => {
      const dias = Math.min(365, Math.max(1,
        Math.floor(((input.fechaCorte ?? new Date()).getTime() - e.fechaIngreso.getTime()) / (1000 * 60 * 60 * 24))
      ));
      return {
        employeeId: e.id,
        nombre: `${e.nombre} ${e.apellidoPaterno}`,
        diasTrabajados: dias,
        salarioDiario: e.salarioDiario,
      };
    });

    const ptuResult = calcularPtu({
      utilidadFiscalGravable: input.utilidadFiscalGravable,
      employees: ptuEmployees,
      topeSalarioPtu: input.topeSalarioPtu,
    });

    ptuDistribuciones = new Map(
      ptuResult.distribuciones.map((d) => [d.employeeId, { monto: d.montoTotal, exento: d.montoExento }])
    );
  }

  // Create the run
  const run = await prisma.payrollRun.create({
    data: {
      companyId: input.companyId,
      periodo,
      fechaPago: input.fechaPago,
      tipo: input.tipo,
      status: "DRAFT",
      extraData: {
        // Días pagados del periodo: los usan el recálculo por incidencias y el
        // timbrado (num_dias_pagados) — antes se re-derivaban del neto.
        diasPagados: input.diasPagados,
        diasAguinaldo: input.diasAguinaldo,
        fechaCorte: input.fechaCorte?.toISOString(),
        diasVacacionesTomar: input.diasVacacionesTomar,
        primaVacacionalPct: input.primaVacacionalPct,
        utilidadFiscalGravable: input.utilidadFiscalGravable,
        topeSalarioPtu: input.topeSalarioPtu,
        ejercicio: input.ejercicio,
        ptuMontoTotal: input.ptuMontoTotal,
      },
    },
  });

  // Incidencias del periodo (sólo ORDINARIA): las capturadas antes de crear la
  // corrida entran directo al cálculo; las que se capturen después disparan el
  // recálculo del empleado (ver recalcularPayrollRun).
  const incidenciasPorEmpleado: Map<string, Incidencia[]> =
    input.tipo === "ORDINARIA"
      ? await incidenciasDelPeriodo(
          input.companyId,
          employees.map((e) => e.id),
          input.periodoInicio,
          input.periodoFin
        )
      : new Map();

  // Calculate all employees (pure math, no network calls)
  let sumPerc = 0, sumDed = 0, sumNeto = 0;
  let tarifasVerificadas = true;
  const itemsData: Prisma.PayrollItemCreateManyInput[] = [];

  for (const emp of employees) {
    const calc = calcularNomina({
      employee: emp as Employee & { tipoDescuentoInfonavit?: string | null },
      diasPagados: input.diasPagados,
      tipo: input.tipo,
      // Tarifa/subsidio del ejercicio/mes de la FECHA DE PAGO (Art. 96).
      ejercicio: input.fechaPago.getFullYear(),
      mes: input.fechaPago.getMonth() + 1,
      diasAguinaldo: input.diasAguinaldo,
      fechaCorte: input.fechaCorte,
      aguinaldoMontoOverride: input.aguinaldoMontos?.[emp.id],
      diasVacacionesTomar: input.diasVacacionesTomar,
      primaVacacionalPct: input.primaVacacionalPct,
      ptuMonto: ptuDistribuciones?.get(emp.id)?.monto,
      ptuExento: ptuDistribuciones?.get(emp.id)?.exento,
      incidencias: resumirIncidencias(incidenciasPorEmpleado.get(emp.id) ?? []),
    });

    itemsData.push({
      payrollRunId: run.id,
      employeeId: emp.id,
      ...payrollItemFieldsFromCalc(calc),
    });

    sumPerc += calc.totalPercepciones;
    sumDed += calc.totalDeducciones;
    sumNeto += calc.netoAPagar;
    if (!calc.isrTarifaVerificada) tarifasVerificadas = false;
  }

  // Batch insert all items in one query
  await prisma.payrollItem.createMany({ data: itemsData });

  // Update run totals
  await prisma.payrollRun.update({
    where: { id: run.id },
    data: {
      status: "CALCULATED",
      totalPercepciones: Math.round(sumPerc * 100) / 100,
      totalDeducciones: Math.round(sumDed * 100) / 100,
      totalNeto: Math.round(sumNeto * 100) / 100,
    },
  });

  return {
    ok: true,
    runId: run.id,
    itemCount: employees.length,
    totalPercepciones: Math.round(sumPerc * 100) / 100,
    totalDeducciones: Math.round(sumDed * 100) / 100,
    totalNeto: Math.round(sumNeto * 100) / 100,
    // ISR calculado con tarifa vencida o subsidio sin cotejar (p.ej. tarifa
    // mensual 2026 pendiente de Cuadros Permanentes) — revisar antes de timbrar.
    tarifaWarning: tarifasVerificadas
      ? null
      : "ISR retenido calculado con tarifa/subsidio sin verificar para el ejercicio — cotejar contra Anexo 8 / decreto vigente antes de timbrar.",
    // Pagar bajo el mínimo es violación LFT y el SBC queda mal — avisar, no
    // bloquear (el mínimo aplicable puede ser ZLFN; el general es el piso país).
    salarioMinimoWarning: (() => {
      const bajo = employees.filter((e) => e.salarioDiario < SALARIO_MINIMO_GENERAL);
      if (bajo.length === 0) return null;
      const nombres = bajo.slice(0, 5).map((e) => `${e.nombre} ${e.apellidoPaterno}`).join(", ");
      return `${bajo.length} empleado(s) con salario diario por debajo del mínimo general (${SALARIO_MINIMO_GENERAL.toFixed(2)}): ${nombres}${bajo.length > 5 ? "…" : ""}`;
    })(),
  };
}

// ─── Mapeo calc → columnas de PayrollItem ────────────────────────────────────
// Único punto donde el resultado del motor se traduce a columnas del item —
// lo usan el cálculo inicial y el recálculo por incidencias.
function payrollItemFieldsFromCalc(calc: NominaCalcResult) {
  const ptuPerc = calc.percepciones.find((p) => p.tipoPercepcion === "003");
  const horasExtraPerc = calc.percepciones.find((p) => p.tipoPercepcion === "019");
  const bonoPerc = calc.percepciones.find((p) => p.tipoPercepcion === "038");
  const comisionPerc = calc.percepciones.find((p) => p.tipoPercepcion === "028");
  const primaVacPerc = calc.percepciones.find((p) => p.tipoPercepcion === "021");
  const otrosDescuentos = calc.deducciones
    .filter((d) => d.tipoDeduccion === "004")
    .reduce((s, d) => s + d.importe, 0);

  return {
    sueldoBase: calc.percepciones.find((p) => p.tipoPercepcion === "001")?.importeGravado ?? 0,
    horasExtra: horasExtraPerc ? horasExtraPerc.importeGravado + horasExtraPerc.importeExento : 0,
    bonosPagoFijo: bonoPerc ? bonoPerc.importeGravado + bonoPerc.importeExento : 0,
    bonosPagoVar: comisionPerc ? comisionPerc.importeGravado + comisionPerc.importeExento : 0,
    isrRetenido: calc.isrRetenido,
    imssObrero: calc.imssObrero,
    imssPatronal: calc.imssPatronal,
    infonavit: calc.infonavitDeduccion,
    otrasDeducc: Math.round(otrosDescuentos * 100) / 100,
    aguinaldo: calc.aguinaldoResult?.montoTotal ?? 0,
    primaVacacional:
      calc.vacacionesResult?.montoPrimaVacacional ??
      (primaVacPerc ? primaVacPerc.importeGravado + primaVacPerc.importeExento : 0),
    vacaciones: calc.vacacionesResult?.pagoVacaciones ?? 0,
    ptu: ptuPerc ? ptuPerc.importeGravado + ptuPerc.importeExento : 0,
    totalPercepciones: calc.totalPercepciones,
    totalDeducciones: calc.totalDeducciones,
    netoAPagar: calc.netoAPagar,
  };
}

/** Días pagados con los que se calculó la corrida: primero extraData (corridas
 *  nuevas); para corridas previas, los días naturales del periodo. */
function diasPagadosDeRun(run: { periodo: string; extraData: unknown }): number {
  const extra = (run.extraData ?? {}) as Record<string, unknown>;
  const guardados = Number(extra.diasPagados);
  if (Number.isFinite(guardados) && guardados > 0) return guardados;
  return diasDelPeriodo(run.periodo) ?? 15;
}

// ─── Recalcular una corrida (o un empleado) con sus incidencias ──────────────
// Después de capturar/eliminar incidencias el cliente NUNCA edita importes a
// mano: se recalcula el item completo con el motor (calcularNomina) y se
// actualizan los totales de la corrida. Sólo corridas DRAFT/CALCULATED de la
// app (las timbradas ya emitieron CFDI; las importadas del SAT son histórico).

export type RecalcResult = {
  ok: boolean;
  recalculados?: number;
  totalPercepciones?: number;
  totalDeducciones?: number;
  totalNeto?: number;
  tarifaWarning?: string | null;
  error?: string;
};

export async function recalcularPayrollRun(
  payrollRunId: string,
  employeeId?: string
): Promise<RecalcResult> {
  const run = await prisma.payrollRun.findUnique({
    where: { id: payrollRunId },
    include: { items: { include: { employee: true } } },
  });
  if (!run) return { ok: false, error: "Corrida no encontrada" };
  if (run.status === "STAMPED" || run.status === "PAID") {
    return { ok: false, error: "La corrida ya está timbrada — los CFDIs emitidos no se recalculan." };
  }
  if (run.origen === "SAT") {
    return { ok: false, error: "Las corridas importadas del SAT son histórico de sólo lectura." };
  }
  if (run.tipo !== "ORDINARIA") {
    return { ok: false, error: "Las incidencias sólo aplican a corridas ordinarias." };
  }

  const rango = rangoDelPeriodo(run.periodo);
  if (!rango) return { ok: false, error: `Periodo de corrida inválido: ${run.periodo}` };
  const diasPagados = diasPagadosDeRun(run);

  const targets = employeeId
    ? run.items.filter((i) => i.employeeId === employeeId)
    : run.items;
  if (targets.length === 0) {
    return { ok: false, error: "El empleado no pertenece a esta corrida." };
  }

  const incidenciasPorEmpleado = await incidenciasDelPeriodo(
    run.companyId,
    targets.map((i) => i.employeeId),
    rango.inicio,
    rango.fin
  );

  let tarifasVerificadas = true;
  for (const item of targets) {
    const calc = calcularNomina({
      employee: item.employee as Employee & { tipoDescuentoInfonavit?: string | null },
      diasPagados,
      tipo: run.tipo,
      ejercicio: run.fechaPago.getFullYear(),
      mes: run.fechaPago.getMonth() + 1,
      incidencias: resumirIncidencias(incidenciasPorEmpleado.get(item.employeeId) ?? []),
    });
    if (!calc.isrTarifaVerificada) tarifasVerificadas = false;
    await prisma.payrollItem.update({
      where: { id: item.id },
      data: payrollItemFieldsFromCalc(calc),
    });
  }

  // Totales de la corrida sobre TODOS los items (recalculados o no).
  const agg = await prisma.payrollItem.aggregate({
    where: { payrollRunId },
    _sum: { totalPercepciones: true, totalDeducciones: true, netoAPagar: true },
  });
  const totalPercepciones = Math.round((agg._sum.totalPercepciones ?? 0) * 100) / 100;
  const totalDeducciones = Math.round((agg._sum.totalDeducciones ?? 0) * 100) / 100;
  const totalNeto = Math.round((agg._sum.netoAPagar ?? 0) * 100) / 100;

  await prisma.payrollRun.update({
    where: { id: payrollRunId },
    data: { status: "CALCULATED", totalPercepciones, totalDeducciones, totalNeto },
  });

  return {
    ok: true,
    recalculados: targets.length,
    totalPercepciones,
    totalDeducciones,
    totalNeto,
    tarifaWarning: tarifasVerificadas
      ? null
      : "ISR retenido calculado con tarifa/subsidio sin verificar para el ejercicio — cotejar antes de timbrar.",
  };
}

// ─── Stamping with concurrency control ───────────────────────────────────────

export type StampResult = {
  ok: boolean;
  stamped: number;
  total: number;
  errors: string[];
};

/** Run N promises at a time, returning results in order */
async function parallelLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Libera el candado de timbrado sin tocar el resto de extraData (merge JSONB). */
async function liberarCandadoTimbrado(payrollRunId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "PayrollRun"
    SET "extraData" = COALESCE("extraData", '{}'::jsonb) || '{"stampingInProgress": false}'::jsonb,
        "updatedAt" = NOW()
    WHERE "id" = ${payrollRunId}
  `;
}

/** Opciones del timbrado de una corrida (aplican a TODOS sus CFDIs). */
export type StampOpciones = {
  /** Fecha de emisión del CFDI (≤72 h atrás, validada con resolverFechaCfdi). */
  fechaCfdi?: Date;
};

export async function stampPayrollRun(
  payrollRunId: string,
  opciones: StampOpciones = {}
): Promise<StampResult> {
  // ── Candado atómico contra doble timbrado ──────────────────────────────────
  // Dos llamadas concurrentes (doble clic en "Timbrar", o timbrado individual
  // que se traslapa con el lote del cockpit) NO deben emitir CFDIs duplicados
  // ante el SAT. Como el estado permanece CALCULATED durante el timbrado, la
  // reclamación se hace en UNA sola sentencia condicional: marca
  // extraData.stampingInProgress = true SÓLO si la corrida sigue CALCULATED y
  // nadie más la tiene reclamada. Se usa SQL directo porque el filtro de
  // Prisma sobre rutas JSON no distingue de forma fiable la clave ausente
  // (extracción -> NULL en SQL), y las corridas nunca timbradas no traen la
  // clave. Sólo una de las llamadas concurrentes obtiene claimed = 1; la otra
  // recibe 0 y aborta sin emitir nada.
  const claimed = await prisma.$executeRaw`
    UPDATE "PayrollRun"
    SET "extraData" = COALESCE("extraData", '{}'::jsonb) || '{"stampingInProgress": true, "stampedCount": 0}'::jsonb,
        "updatedAt" = NOW()
    WHERE "id" = ${payrollRunId}
      AND "status" = 'CALCULATED'::"PayrollStatus"
      AND COALESCE("extraData"->>'stampingInProgress', 'false') <> 'true'
  `;

  if (claimed === 0) {
    // No se obtuvo el candado: diagnosticar el motivo para el usuario.
    const existente = await prisma.payrollRun.findUnique({
      where: { id: payrollRunId },
      select: { status: true, extraData: true, _count: { select: { items: true } } },
    });
    if (!existente) return { ok: false, stamped: 0, total: 0, errors: ["Corrida no encontrada"] };
    const motivo =
      motivoTimbradoNoDisponible(existente) ??
      "No fue posible reclamar la corrida para timbrar. Reintente en unos momentos.";
    return { ok: false, stamped: 0, total: existente._count.items, errors: [motivo] };
  }

  // El candado está tomado: cualquier salida (éxito, error de negocio o
  // excepción inesperada) debe liberarlo para no bloquear reintentos.
  try {
    return await stampPayrollRunClaimed(payrollRunId, opciones);
  } catch (e) {
    await liberarCandadoTimbrado(payrollRunId).catch(() => {
      // La liberación es el mejor esfuerzo; el error original es el relevante.
    });
    throw e;
  }
}

/**
 * Cuerpo del timbrado. Se invoca ÚNICAMENTE con el candado ya reclamado
 * (stampingInProgress = true); las actualizaciones finales lo liberan.
 */
async function stampPayrollRunClaimed(
  payrollRunId: string,
  opciones: StampOpciones = {}
): Promise<StampResult> {
  // La corrida y sus items se leen DESPUÉS de reclamar el candado, para que el
  // filtro de items ya timbrados (cfdiUuid) vea el estado más reciente.
  const run = await prisma.payrollRun.findUnique({
    where: { id: payrollRunId },
    include: { items: { include: { employee: true } } },
  });

  if (!run) {
    return { ok: false, stamped: 0, total: 0, errors: ["Corrida no encontrada"] };
  }

  const [periodoInicio, periodoFin] = run.periodo.split("/");
  const unstamped = run.items.filter((item) => !item.cfdiUuid);
  const alreadyStamped = run.items.length - unstamped.length;

  // Incidencias del periodo (sólo ORDINARIA): los empleados que tienen
  // incidencias con efecto monetario se timbran con el desglose exacto del
  // motor (exenciones de horas extra/prima vacacional, bonos, descuentos) —
  // el CFDI nunca se arma re-derivando una sola percepción gravada.
  const rango = rangoDelPeriodo(run.periodo);
  const incidenciasPorEmpleado: Map<string, Incidencia[]> =
    run.tipo === "ORDINARIA" && rango
      ? await incidenciasDelPeriodo(
          run.companyId,
          unstamped.map((i) => i.employeeId),
          rango.inicio,
          rango.fin
        )
      : new Map();
  const diasPagadosRun = diasPagadosDeRun(run);

  const errors: string[] = [];
  let newlyStamped = 0;

  // Build tasks for parallel execution
  const tasks = unstamped.map((item) => async () => {
    try {
      const resumen: IncidenciasResumen = resumirIncidencias(
        incidenciasPorEmpleado.get(item.employeeId) ?? []
      );

      let desglose;
      // NumDiasPagados por defecto: los días con los que se CALCULÓ la corrida
      // (extraData.diasPagados, o los días naturales del periodo para corridas
      // previas) — nunca re-derivados del neto/percepciones, que con bonos,
      // horas extra o SDI distinto al salario diario daban un número absurdo.
      let diasPagadosCfdi = diasPagadosRun;
      let tipoNominaCfdi: "O" | "E" = "O";
      let periodoInicioCfdi = new Date(periodoInicio);
      let periodoFinCfdi = new Date(periodoFin);

      if (run.tipo === "AGUINALDO" || run.tipo === "PTU") {
        // Corridas especiales: el CFDI se arma con el desglose EXACTO del
        // motor (separación gravado/exento del aguinaldo — 30 UMA, Art. 93
        // fracc. XIV LISR — y de la PTU — 15 UMA, misma fracción), nunca con
        // una sola percepción de sueldo 100% gravada. Conforme a la Guía de
        // llenado del complemento de nómina del SAT (Apéndices 4 y 5): se
        // timbran como nómina EXTRAORDINARIA (TipoNomina = E) con
        // NumDiasPagados = 1 y FechaInicialPago = FechaFinalPago = fecha de
        // pago.
        const extra = (run.extraData ?? {}) as Record<string, unknown>;
        const umaPago = umaDiariaDelEjercicio(run.fechaPago.getFullYear()) ?? UMA_DIARIO;
        // El monto por empleado se reconstruye desde el propio item (columna
        // aguinaldo/ptu) — reproduce exactamente lo revisado, incluyendo los
        // ajustes manuales de la vista previa; el motor rehace exención e ISR
        // y el guard de neto bloquea cualquier divergencia.
        const calc = calcularNomina({
          employee: item.employee as Employee & { tipoDescuentoInfonavit?: string | null },
          diasPagados: 0,
          tipo: run.tipo,
          ejercicio: run.fechaPago.getFullYear(),
          mes: run.fechaPago.getMonth() + 1,
          ...(run.tipo === "AGUINALDO"
            ? {
                diasAguinaldo: Number(extra.diasAguinaldo) || undefined,
                fechaCorte: extra.fechaCorte ? new Date(String(extra.fechaCorte)) : undefined,
                aguinaldoMontoOverride: item.aguinaldo,
              }
            : {
                ptuMonto: item.ptu,
                ptuExento: Math.round(Math.min(item.ptu, PTU_EXENTO_UMA * umaPago) * 100) / 100,
              }),
        });
        if (Math.abs(calc.netoAPagar - item.netoAPagar) > 0.05) {
          errors.push(
            `${item.employee.nombre} ${item.employee.apellidoPaterno}: los importes del recibo no coinciden con el recálculo del motor (neto ${calc.netoAPagar.toFixed(2)} vs ${item.netoAPagar.toFixed(2)}). Elimine y regenere la corrida especial antes de timbrar.`
          );
          return;
        }
        desglose = {
          percepciones: calc.percepciones,
          deducciones: calc.deducciones,
          totalPercepciones: calc.totalPercepciones,
          totalDeducciones: calc.totalDeducciones,
          netoAPagar: calc.netoAPagar,
        };
        tipoNominaCfdi = "E";
        diasPagadosCfdi = 1;
        periodoInicioCfdi = run.fechaPago;
        periodoFinCfdi = run.fechaPago;
      } else if (resumenTieneEfecto(resumen)) {
        // Recalcular con el MISMO motor e insumos que produjo el item revisado
        // y verificar que coincide antes de timbrar: si alguien capturó una
        // incidencia (o cambió el salario) sin recalcular, se bloquea el
        // timbrado de ese empleado en vez de emitir un CFDI distinto a lo
        // que el contador revisó.
        const calc = calcularNomina({
          employee: item.employee as Employee & { tipoDescuentoInfonavit?: string | null },
          diasPagados: diasPagadosRun,
          tipo: run.tipo,
          ejercicio: run.fechaPago.getFullYear(),
          mes: run.fechaPago.getMonth() + 1,
          incidencias: resumen,
        });
        if (Math.abs(calc.netoAPagar - item.netoAPagar) > 0.05) {
          errors.push(
            `${item.employee.nombre} ${item.employee.apellidoPaterno}: los importes cambiaron desde el último cálculo (neto calculado ${calc.netoAPagar.toFixed(2)} vs ${item.netoAPagar.toFixed(2)}). Recalcule la corrida antes de timbrar.`
          );
          return;
        }
        desglose = {
          percepciones: calc.percepciones,
          deducciones: calc.deducciones,
          totalPercepciones: calc.totalPercepciones,
          totalDeducciones: calc.totalDeducciones,
          netoAPagar: calc.netoAPagar,
        };
        // El CFDI reporta los días efectivamente pagados (faltas e
        // incapacidades ya descontadas).
        diasPagadosCfdi = calc.diasEfectivos;
      }

      const result = await emitNominaCfdi({
        companyId: run.companyId,
        employeeId: item.employeeId,
        periodoInicio: periodoInicioCfdi,
        periodoFin: periodoFinCfdi,
        diasPagados: diasPagadosCfdi,
        fechaPago: run.fechaPago,
        sueldoBruto: item.totalPercepciones,
        desglose,
        tipoNomina: tipoNominaCfdi,
        fechaCfdi: opciones.fechaCfdi,
      });

      if (result.ok && result.uuid) {
        await prisma.payrollItem.update({
          where: { id: item.id },
          data: { cfdiUuid: result.uuid, facturapiId: result.invoiceId },
        });
        newlyStamped++;

        // Update progress every 10 stamps
        if (newlyStamped % 10 === 0) {
          await prisma.payrollRun.update({
            where: { id: payrollRunId },
            data: {
              extraData: {
                ...(run.extraData as Record<string, unknown> ?? {}),
                stampingInProgress: true,
                stampedCount: alreadyStamped + newlyStamped,
              },
            },
          });
        }
      } else {
        errors.push(`${item.employee.nombre} ${item.employee.apellidoPaterno}: ${result.error}`);
      }
    } catch (e) {
      errors.push(`${item.employee.nombre}: ${e instanceof Error ? e.message : "Error desconocido"}`);
    }
  });

  // Run with concurrency limit
  await parallelLimit(tasks, STAMP_CONCURRENCY);

  const totalStamped = alreadyStamped + newlyStamped;

  // Update final status
  if (totalStamped === run.items.length) {
    await prisma.payrollRun.update({
      where: { id: payrollRunId },
      data: {
        status: "STAMPED",
        extraData: { ...(run.extraData as Record<string, unknown> ?? {}), stampingInProgress: false, stampedCount: totalStamped },
      },
    });
  } else {
    await prisma.payrollRun.update({
      where: { id: payrollRunId },
      data: {
        extraData: { ...(run.extraData as Record<string, unknown> ?? {}), stampingInProgress: false, stampedCount: totalStamped },
      },
    });
  }

  return { ok: errors.length === 0, stamped: totalStamped, total: run.items.length, errors };
}
