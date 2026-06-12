// ─────────────────────────────────────────────────────────────────────────────
// Adapter: Employee rows → EmpleadoNomina. Structurally typed (no @prisma/client
// import). claveEntFed is validated against the entidad catalog; the monthly
// base is ESTIMATED as salarioDiario × 30.4 (a lower bound — real ISN should use
// the period's remuneraciones gravadas from payroll once wired).
// ─────────────────────────────────────────────────────────────────────────────

import { esEntidad } from "../rules";
import type { EmpleadoNomina } from "./types";

/** Días promedio por mes para estimar la base mensual desde el salario diario. */
export const DIAS_MES = 30.4;

export interface EmployeeLike {
  id: string;
  salarioDiario: number;
  claveEntFed: string;
  isActive: boolean;
}

export function empleadoNominaDesde(emp: EmployeeLike): EmpleadoNomina {
  return {
    id: emp.id,
    entidad: esEntidad(emp.claveEntFed) ? emp.claveEntFed : undefined,
    baseMensual: emp.salarioDiario * DIAS_MES,
    activo: emp.isActive,
  };
}

/** A payroll line joined to its employee's claveEntFed (the exact-base source). */
export interface PayrollItemLike {
  employeeId: string;
  claveEntFed: string;
  /** Remuneraciones del comprobante de nómina. */
  totalPercepciones: number;
}

/**
 * Aggregate a period's PayrollItems into one EmpleadoNomina per employee, with
 * baseMensual = sum of totalPercepciones (real gross — the exact ISN base,
 * preferred over the salarioDiario estimate). An employee with payroll in the
 * period is treated as activo.
 */
export function agregarNominaPorEmpleado(items: PayrollItemLike[]): EmpleadoNomina[] {
  const porEmpleado = new Map<string, { claveEntFed: string; base: number }>();
  for (const it of items) {
    const prev = porEmpleado.get(it.employeeId);
    if (prev) prev.base += it.totalPercepciones;
    else porEmpleado.set(it.employeeId, { claveEntFed: it.claveEntFed, base: it.totalPercepciones });
  }
  return [...porEmpleado].map(([id, v]) => ({
    id,
    entidad: esEntidad(v.claveEntFed) ? v.claveEntFed : undefined,
    baseMensual: v.base,
    activo: true,
  }));
}
