// ─── PayrollRun Batch Orchestrator ───────────────────────────────────────────
// Creates a payroll run for multiple employees, calculates all items, and
// optionally stamps CFDIs in batch.

import { prisma } from "../prisma";
import { calcularNomina, type NominaCalcInput } from "./calc-nomina";
import { calcularPtu, type PtuEmployeeData } from "./ptu";
import { aniosAntiguedad } from "./prestaciones";
import { emitNominaCfdi } from "./emit-nomina";
import type { PayrollRunType, Employee } from "@prisma/client";

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
        Math.floor((input.fechaCorte ?? new Date()).getTime() - e.fechaIngreso.getTime()) / (1000 * 60 * 60 * 24)
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

  // Calculate each employee
  let sumPerc = 0, sumDed = 0, sumNeto = 0;

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

    await prisma.payrollItem.create({
      data: {
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
        ptu: calc.percepciones.find((p) => p.tipoPercepcion === "003")
          ? (calc.percepciones.find((p) => p.tipoPercepcion === "003")!.importeGravado +
             calc.percepciones.find((p) => p.tipoPercepcion === "003")!.importeExento)
          : 0,
        totalPercepciones: calc.totalPercepciones,
        totalDeducciones: calc.totalDeducciones,
        netoAPagar: calc.netoAPagar,
      },
    });

    sumPerc += calc.totalPercepciones;
    sumDed += calc.totalDeducciones;
    sumNeto += calc.netoAPagar;
  }

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

export type StampResult = {
  ok: boolean;
  stamped: number;
  errors: string[];
};

export async function stampPayrollRun(payrollRunId: string): Promise<StampResult> {
  const run = await prisma.payrollRun.findUnique({
    where: { id: payrollRunId },
    include: { items: { include: { employee: true } } },
  });

  if (!run) return { ok: false, stamped: 0, errors: ["Corrida no encontrada"] };
  if (run.status !== "CALCULATED") {
    return { ok: false, stamped: 0, errors: [`Estado inválido: ${run.status}. Debe estar CALCULATED.`] };
  }

  const [periodoInicio, periodoFin] = run.periodo.split("/");
  let stamped = 0;
  const errors: string[] = [];

  for (const item of run.items) {
    if (item.cfdiUuid) { stamped++; continue; } // already stamped

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
        stamped++;
      } else {
        errors.push(`${item.employee.nombre} ${item.employee.apellidoPaterno}: ${result.error}`);
      }
    } catch (e) {
      errors.push(`${item.employee.nombre}: ${e instanceof Error ? e.message : "Error desconocido"}`);
    }
  }

  if (stamped === run.items.length) {
    await prisma.payrollRun.update({
      where: { id: payrollRunId },
      data: { status: "STAMPED" },
    });
  }

  return { ok: errors.length === 0, stamped, errors };
}
