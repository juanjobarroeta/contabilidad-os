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
