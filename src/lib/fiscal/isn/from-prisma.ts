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
