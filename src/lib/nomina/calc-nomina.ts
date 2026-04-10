// ─── Pure Nómina Calculation ─────────────────────────────────────────────────
// Called by both standalone emission and batch payroll runs. No DB or Facturapi
// calls — just math.

import type { Employee, PayrollRunType } from "@prisma/client";
import { calcularIsrRetenido } from "./isr";
import { calcularImss, type ImssCalcResult } from "./imss";
import { calcularInfonavit } from "./infonavit";
import { calcularAguinaldo, calcularVacaciones, type AguinaldoResult, type VacacionesResult } from "./prestaciones";
import { calcularPtu, type PtuDistribucion } from "./ptu";

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type PercepcionItem = {
  tipoPercepcion: string; // SAT code: "001" Sueldos, "002" Aguinaldo, "003" PTU, "021" Prima vac
  clave: string;
  concepto: string;
  importeGravado: number;
  importeExento: number;
};

export type DeduccionItem = {
  tipoDeduccion: string; // SAT code: "001" IMSS, "002" ISR, "006" Infonavit, "010" aportaciones
  clave: string;
  concepto: string;
  importe: number;
};

export type NominaCalcInput = {
  employee: Employee & { tipoDescuentoInfonavit?: string | null };
  diasPagados: number;
  tipo: PayrollRunType;
  sueldoBruto?: number;
  // For AGUINALDO
  diasAguinaldo?: number;
  fechaCorte?: Date;
  // For VACACIONES
  diasVacacionesTomar?: number;
  primaVacacionalPct?: number;
  // For PTU (single-employee slice from calcularPtu)
  ptuMonto?: number;
  ptuExento?: number;
};

export type NominaCalcResult = {
  percepciones: PercepcionItem[];
  deducciones: DeduccionItem[];
  totalPercepciones: number;
  totalDeducciones: number;
  netoAPagar: number;
  imssCalc: ImssCalcResult;
  isrRetenido: number;
  imssObrero: number;
  imssPatronal: number;
  infonavitDeduccion: number;
  tipoNomina: "O" | "E"; // Ordinaria vs Extraordinaria
  // Extraordinary details
  aguinaldoResult?: AguinaldoResult;
  vacacionesResult?: VacacionesResult;
  ptuDistribucion?: PtuDistribucion;
};

export function calcularNomina(input: NominaCalcInput): NominaCalcResult {
  const { employee, diasPagados, tipo } = input;
  const sdi = employee.salarioDiarioIntegrado ?? employee.salarioDiario;

  // ── Determine tipo_nomina ──
  const tipoNomina: "O" | "E" =
    tipo === "ORDINARIA" ? "O" : "E";

  // ── Percepciones ──
  const percepciones: PercepcionItem[] = [];
  let totalGravado = 0;
  let totalExento = 0;
  let aguinaldoResult: AguinaldoResult | undefined;
  let vacacionesResult: VacacionesResult | undefined;

  if (tipo === "ORDINARIA" || tipo === "EXTRAORDINARIA") {
    const sueldoBruto = input.sueldoBruto ?? r2(employee.salarioDiario * diasPagados);
    percepciones.push({
      tipoPercepcion: "001",
      clave: "001",
      concepto: "Sueldos, Salarios y Rayas",
      importeGravado: sueldoBruto,
      importeExento: 0,
    });
    totalGravado = sueldoBruto;

  } else if (tipo === "AGUINALDO") {
    aguinaldoResult = calcularAguinaldo({
      salarioDiario: employee.salarioDiario,
      fechaIngreso: employee.fechaIngreso,
      fechaCorte: input.fechaCorte ?? new Date(new Date().getFullYear(), 11, 31),
      diasAguinaldo: input.diasAguinaldo,
    });
    percepciones.push({
      tipoPercepcion: "002",
      clave: "002",
      concepto: "Gratificación Anual (Aguinaldo)",
      importeGravado: aguinaldoResult.montoGravado,
      importeExento: aguinaldoResult.montoExento,
    });
    totalGravado = aguinaldoResult.montoGravado;
    totalExento = aguinaldoResult.montoExento;

  } else if (tipo === "VACACIONES") {
    vacacionesResult = calcularVacaciones({
      salarioDiario: employee.salarioDiario,
      fechaIngreso: employee.fechaIngreso,
      fechaCorte: input.fechaCorte ?? new Date(),
      primaVacacionalPct: input.primaVacacionalPct,
      diasVacacionesTomar: input.diasVacacionesTomar,
    });
    // Vacation pay itself (gravado)
    percepciones.push({
      tipoPercepcion: "001",
      clave: "001",
      concepto: "Vacaciones",
      importeGravado: vacacionesResult.pagoVacaciones,
      importeExento: 0,
    });
    // Prima vacacional (partially exempt)
    percepciones.push({
      tipoPercepcion: "021",
      clave: "021",
      concepto: "Prima Vacacional",
      importeGravado: vacacionesResult.primaGravada,
      importeExento: vacacionesResult.primaExenta,
    });
    totalGravado = vacacionesResult.pagoVacaciones + vacacionesResult.primaGravada;
    totalExento = vacacionesResult.primaExenta;

  } else if (tipo === "PTU") {
    const montoTotal = input.ptuMonto ?? 0;
    const montoExento = input.ptuExento ?? 0;
    const montoGravado = r2(montoTotal - montoExento);
    percepciones.push({
      tipoPercepcion: "003",
      clave: "003",
      concepto: "Participación de los Trabajadores en las Utilidades (PTU)",
      importeGravado: montoGravado,
      importeExento: montoExento,
    });
    totalGravado = montoGravado;
    totalExento = montoExento;
  }

  const totalPercepciones = r2(totalGravado + totalExento);

  // ── Deducciones ──
  const deducciones: DeduccionItem[] = [];

  // ISR on gravado portion
  const isrCalc = calcularIsrRetenido({
    baseGravable: totalGravado,
    periodicidadPago: tipo === "ORDINARIA" ? employee.periodicidadPago : "05", // monthly equiv for extraordinary
  });
  if (isrCalc.isrRetenido > 0) {
    deducciones.push({
      tipoDeduccion: "002",
      clave: "002",
      concepto: "ISR",
      importe: isrCalc.isrRetenido,
    });
  }

  // IMSS — only on ORDINARIA
  const imssCalc = calcularImss({
    salarioBaseCotizacion: sdi,
    diasPagados,
    riesgoPuesto: employee.riesgoPuesto,
  });
  if (tipo === "ORDINARIA" && imssCalc.obrero.total > 0) {
    deducciones.push({
      tipoDeduccion: "001",
      clave: "001",
      concepto: "IMSS",
      importe: imssCalc.obrero.total,
    });
  }

  // Infonavit — only on ORDINARIA
  let infonavitDeduccion = 0;
  if (tipo === "ORDINARIA") {
    infonavitDeduccion = calcularInfonavit({
      tipoDescuento: employee.tipoDescuentoInfonavit ?? null,
      descuentoInfonavit: employee.descuentoInfonavit ?? null,
      salarioBaseCotizacion: sdi,
      diasPagados,
    });
    if (infonavitDeduccion > 0) {
      deducciones.push({
        tipoDeduccion: "010",
        clave: "006",
        concepto: "INFONAVIT",
        importe: infonavitDeduccion,
      });
    }
  }

  const totalDeducciones = r2(deducciones.reduce((s, d) => s + d.importe, 0));
  const netoAPagar = r2(totalPercepciones - totalDeducciones);

  return {
    percepciones,
    deducciones,
    totalPercepciones,
    totalDeducciones,
    netoAPagar,
    imssCalc,
    isrRetenido: isrCalc.isrRetenido,
    imssObrero: tipo === "ORDINARIA" ? imssCalc.obrero.total : 0,
    imssPatronal: imssCalc.patronal.total,
    infonavitDeduccion,
    tipoNomina,
    aguinaldoResult,
    vacacionesResult,
  };
}
