// ─── PayrollRun Batch Orchestrator ───────────────────────────────────────────
// Creates a payroll run for multiple employees, calculates all items, and
// stamps CFDIs in batch with concurrency control.
//
// Designed to handle 1,000+ employees:
// - Calculation: batch DB inserts via createMany
// - Stamping: concurrent with limit (5 at a time), progress tracked on run,
//   API returns immediately, client polls for progress.

import { prisma } from "../prisma";
import { calcularNomina, type NominaCalcInput } from "./calc-nomina";
import { calcularPtu, type PtuEmployeeData } from "./ptu";
import { emitNominaCfdi } from "./emit-nomina";
import type { PayrollRunType, Employee, Prisma } from "@prisma/client";

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
};

export type PayrollRunResult = {
  ok: boolean;
  runId?: string;
  itemCount?: number;
  totalPercepciones?: number;
  totalDeducciones?: number;
  totalNeto?: number;
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
  if (input.tipo === "PTU" && input.utilidadFiscalGravable) {
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
        diasAguinaldo: input.diasAguinaldo,
        fechaCorte: input.fechaCorte?.toISOString(),
        diasVacacionesTomar: input.diasVacacionesTomar,
        primaVacacionalPct: input.primaVacacionalPct,
        utilidadFiscalGravable: input.utilidadFiscalGravable,
        topeSalarioPtu: input.topeSalarioPtu,
      },
    },
  });

  // Calculate all employees (pure math, no network calls)
  let sumPerc = 0, sumDed = 0, sumNeto = 0;
  const itemsData: Prisma.PayrollItemCreateManyInput[] = [];

  for (const emp of employees) {
    const calcInput: NominaCalcInput = {
      employee: emp as Employee & { tipoDescuentoInfonavit?: string | null },
      diasPagados: input.diasPagados,
      tipo: input.tipo,
      diasAguinaldo: input.diasAguinaldo,
      fechaCorte: input.fechaCorte,
      diasVacacionesTomar: input.diasVacacionesTomar,
      primaVacacionalPct: input.primaVacacionalPct,
      ptuMonto: ptuDistribuciones?.get(emp.id)?.monto,
      ptuExento: ptuDistribuciones?.get(emp.id)?.exento,
    };

    const calc = calcularNomina(calcInput);

    const ptuPerc = calc.percepciones.find((p) => p.tipoPercepcion === "003");
    itemsData.push({
      payrollRunId: run.id,
      employeeId: emp.id,
      sueldoBase: calc.percepciones.find((p) => p.tipoPercepcion === "001")?.importeGravado ?? 0,
      isrRetenido: calc.isrRetenido,
      imssObrero: calc.imssObrero,
      imssPatronal: calc.imssPatronal,
      infonavit: calc.infonavitDeduccion,
      aguinaldo: calc.aguinaldoResult?.montoTotal ?? 0,
      primaVacacional: calc.vacacionesResult?.montoPrimaVacacional ?? 0,
      vacaciones: calc.vacacionesResult?.pagoVacaciones ?? 0,
      ptu: ptuPerc ? (ptuPerc.importeGravado + ptuPerc.importeExento) : 0,
      totalPercepciones: calc.totalPercepciones,
      totalDeducciones: calc.totalDeducciones,
      netoAPagar: calc.netoAPagar,
    });

    sumPerc += calc.totalPercepciones;
    sumDed += calc.totalDeducciones;
    sumNeto += calc.netoAPagar;
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

export async function stampPayrollRun(payrollRunId: string): Promise<StampResult> {
  const run = await prisma.payrollRun.findUnique({
    where: { id: payrollRunId },
    include: { items: { include: { employee: true } } },
  });

  if (!run) return { ok: false, stamped: 0, total: 0, errors: ["Corrida no encontrada"] };
  if (run.status !== "CALCULATED") {
    return { ok: false, stamped: 0, total: run.items.length, errors: [`Estado inválido: ${run.status}. Debe estar CALCULATED.`] };
  }

  // Mark as stamping in progress
  await prisma.payrollRun.update({
    where: { id: payrollRunId },
    data: { extraData: { ...(run.extraData as Record<string, unknown> ?? {}), stampingInProgress: true, stampedCount: 0 } },
  });

  const [periodoInicio, periodoFin] = run.periodo.split("/");
  const unstamped = run.items.filter((item) => !item.cfdiUuid);
  const alreadyStamped = run.items.length - unstamped.length;

  const errors: string[] = [];
  let newlyStamped = 0;

  // Build tasks for parallel execution
  const tasks = unstamped.map((item) => async () => {
    try {
      const result = await emitNominaCfdi({
        companyId: run.companyId,
        employeeId: item.employeeId,
        periodoInicio: new Date(periodoInicio),
        periodoFin: new Date(periodoFin),
        diasPagados: Math.round(item.totalPercepciones / item.employee.salarioDiario) || 15,
        fechaPago: run.fechaPago,
        sueldoBruto: item.totalPercepciones,
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
