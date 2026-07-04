// ─── PTU (Participación de los Trabajadores en las Utilidades) ───────────────
// Art. 117-131 LFT + Art. 123 Constitutional
// 10% of taxable profit, distributed 50/50 by days worked and by salary.

import { UMA_DIARIO, PTU_PCT, PTU_EXENTO_UMA } from "./constants";

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type PtuEmployeeData = {
  employeeId: string;
  nombre: string;
  diasTrabajados: number; // in the fiscal year (max 365)
  salarioDiario: number;
};

export type PtuDistribucion = {
  employeeId: string;
  nombre: string;
  porDias: number;     // 50% allocated by days worked
  porSalario: number;  // 50% allocated by salary
  montoTotal: number;
  montoExento: number; // 15 × UMA diario
  montoGravado: number;
};

export type PtuInput = {
  utilidadFiscalGravable: number; // Raw profit before PTU percentage
  employees: PtuEmployeeData[];
  topeSalarioPtu?: number; // Art. 127 cap (optional)
};

export type PtuResult = {
  montoTotalRepartible: number;
  distribuciones: PtuDistribucion[];
};

export function calcularPtu(input: PtuInput): PtuResult {
  const { utilidadFiscalGravable, employees, topeSalarioPtu } = input;

  const montoTotalRepartible = r2(utilidadFiscalGravable * PTU_PCT);
  if (montoTotalRepartible <= 0 || employees.length === 0) {
    return { montoTotalRepartible: 0, distribuciones: [] };
  }

  const mitad = r2(montoTotalRepartible / 2);

  // ── First half: by days worked ──
  const totalDias = employees.reduce((s, e) => s + e.diasTrabajados, 0);

  // ── Second half: by salary (capped if topeSalarioPtu provided) ──
  const salarios = employees.map((e) => ({
    ...e,
    salarioCapped: topeSalarioPtu ? Math.min(e.salarioDiario, topeSalarioPtu) : e.salarioDiario,
  }));
  const totalSalario = salarios.reduce((s, e) => s + e.salarioCapped * e.diasTrabajados, 0);

  const distribuciones: PtuDistribucion[] = salarios.map((e) => {
    const porDias = totalDias > 0 ? r2((e.diasTrabajados / totalDias) * mitad) : 0;
    const salarioBase = e.salarioCapped * e.diasTrabajados;
    const porSalario = totalSalario > 0 ? r2((salarioBase / totalSalario) * mitad) : 0;
    const montoTotal = r2(porDias + porSalario);

    // Exempt: 15 × UMA diario
    const montoExento = r2(Math.min(montoTotal, PTU_EXENTO_UMA * UMA_DIARIO));
    const montoGravado = r2(Math.max(0, montoTotal - montoExento));

    return {
      employeeId: e.employeeId,
      nombre: e.nombre,
      porDias,
      porSalario,
      montoTotal,
      montoExento,
      montoGravado,
    };
  });

  return { montoTotalRepartible, distribuciones };
}

// ─── Reparto directo de un monto de PTU (corrida especial de un toque) ───────
// A diferencia de calcularPtu (que parte de la utilidad fiscal y aplica el
// 10%), aquí el contador captura directamente el MONTO a repartir (renglón de
// PTU de la declaración anual) y se distribuye conforme al Art. 123 LFT:
//   - 50% en partes proporcionales a los DÍAS TRABAJADOS en el ejercicio.
//   - 50% en proporción a los SALARIOS DEVENGADOS en el ejercicio.
//
// Tope individual (Art. 127 fracc. VIII LFT, reforma DOF 23-abr-2021): la
// participación por trabajador tiene como límite máximo TRES MESES de su
// salario o el PROMEDIO de la PTU recibida en los últimos tres años, LO QUE
// RESULTE MÁS FAVORABLE. Aquí:
//   - 3 meses de salario = salarioDiario × 90 (convención de 30 días/mes).
//   - El promedio de 3 años sólo se usa cuando el llamador lo provee
//     (`promedioPtu3Anios`, derivado de corridas PTU previas — propias o
//     importadas del SAT). Sin historial, rige el tope de 3 meses.
//   - El excedente que se pierde por el tope NO se redistribuye entre los
//     demás trabajadores: la fracción VIII topa el derecho individual y no
//     ordena redistribución (criterio conservador; el remanente se informa).
//
// Exclusión automática: trabajadores con menos de 60 días trabajados en el
// ejercicio (Art. 127 fracc. VII LFT — trabajadores eventuales). SIMPLIFICACIÓN
// DOCUMENTADA: el umbral aplica en estricto a eventuales; al no distinguir el
// modelo entre planta y eventuales, se aplica a todos (criterio conservador de
// práctica común). Directores, administradores y gerentes generales (fracc. I)
// no tienen bandera en el modelo — se excluyen manualmente en la vista previa.

/** Convención de 3 meses de salario del tope individual: 90 días. */
export const PTU_TOPE_DIAS_SALARIO = 90;
/** Días mínimos trabajados en el ejercicio para participar (Art. 127 fracc. VII LFT). */
export const PTU_DIAS_MINIMOS = 60;

export type RepartoPtuEmpleado = {
  employeeId: string;
  nombre: string;
  /** Días trabajados dentro del ejercicio fiscal repartido (máx. 365). */
  diasTrabajados: number;
  salarioDiario: number;
  /** Salario devengado (sueldo base) en el ejercicio — base de la mitad por salarios. */
  salarioDevengado: number;
  /** Promedio de PTU recibida en los últimos 3 años, si hay historial; null/omitido si no. */
  promedioPtu3Anios?: number | null;
};

export type RepartoPtuAsignacion = {
  employeeId: string;
  nombre: string;
  diasTrabajados: number;
  salarioDevengado: number;
  porDias: number;
  porSalario: number;
  /** Suma de ambas mitades ANTES de aplicar el tope individual. */
  brutoSinTope: number;
  /** max(3 meses de salario, promedio PTU 3 años) — Art. 127 fracc. VIII LFT. */
  topeIndividual: number;
  /** True cuando el tope recortó la asignación. */
  topado: boolean;
  montoTotal: number;
  montoExento: number; // 15 × UMA diaria (Art. 93 fracc. XIV LISR)
  montoGravado: number;
};

export type RepartoPtuExcluido = {
  employeeId: string;
  nombre: string;
  diasTrabajados: number;
  motivo: string;
};

export type RepartoPtuInput = {
  /** Monto total de PTU a repartir (10% de la renta gravable, Art. 117 LFT / 9 CPEUM). */
  montoTotal: number;
  empleados: RepartoPtuEmpleado[];
  /** UMA diaria del ejercicio de pago para la exención. Default: la vigente. */
  umaDiaria?: number;
};

export type RepartoPtuResult = {
  asignaciones: RepartoPtuAsignacion[];
  excluidos: RepartoPtuExcluido[];
  totalAsignado: number;
  /** Monto que quedó sin asignar por los topes individuales (no se redistribuye). */
  remanentePorTopes: number;
};

export function repartirPtu(input: RepartoPtuInput): RepartoPtuResult {
  const uma = input.umaDiaria ?? UMA_DIARIO;

  const excluidos: RepartoPtuExcluido[] = input.empleados
    .filter((e) => e.diasTrabajados < PTU_DIAS_MINIMOS)
    .map((e) => ({
      employeeId: e.employeeId,
      nombre: e.nombre,
      diasTrabajados: e.diasTrabajados,
      motivo: `Menos de ${PTU_DIAS_MINIMOS} días trabajados en el ejercicio (Art. 127 fracc. VII LFT)`,
    }));
  const elegibles = input.empleados.filter((e) => e.diasTrabajados >= PTU_DIAS_MINIMOS);

  if (input.montoTotal <= 0 || elegibles.length === 0) {
    return { asignaciones: [], excluidos, totalAsignado: 0, remanentePorTopes: 0 };
  }

  const mitad = input.montoTotal / 2;
  const totalDias = elegibles.reduce((s, e) => s + e.diasTrabajados, 0);
  const totalSalario = elegibles.reduce((s, e) => s + e.salarioDevengado, 0);

  let totalAsignado = 0;
  let remanentePorTopes = 0;

  const asignaciones: RepartoPtuAsignacion[] = elegibles.map((e) => {
    const porDias = totalDias > 0 ? r2((e.diasTrabajados / totalDias) * mitad) : 0;
    // Guardia: sin salarios devengados (>0) la mitad por salarios no se puede
    // prorratear — se reparte también por días (caso degenerado, documentado).
    const porSalario =
      totalSalario > 0
        ? r2((e.salarioDevengado / totalSalario) * mitad)
        : totalDias > 0
          ? r2((e.diasTrabajados / totalDias) * mitad)
          : 0;
    const brutoSinTope = r2(porDias + porSalario);

    const topeIndividual = r2(
      Math.max(e.salarioDiario * PTU_TOPE_DIAS_SALARIO, e.promedioPtu3Anios ?? 0)
    );
    const topado = brutoSinTope > topeIndividual;
    const montoTotal = topado ? topeIndividual : brutoSinTope;

    const montoExento = r2(Math.min(montoTotal, PTU_EXENTO_UMA * uma));
    const montoGravado = r2(Math.max(0, montoTotal - montoExento));

    totalAsignado = r2(totalAsignado + montoTotal);
    if (topado) remanentePorTopes = r2(remanentePorTopes + (brutoSinTope - topeIndividual));

    return {
      employeeId: e.employeeId,
      nombre: e.nombre,
      diasTrabajados: e.diasTrabajados,
      salarioDevengado: e.salarioDevengado,
      porDias,
      porSalario,
      brutoSinTope,
      topeIndividual,
      topado,
      montoTotal,
      montoExento,
      montoGravado,
    };
  });

  return { asignaciones, excluidos, totalAsignado, remanentePorTopes };
}
