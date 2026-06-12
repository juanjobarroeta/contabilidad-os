// ─────────────────────────────────────────────────────────────────────────────
// ISN (Impuesto Sobre Nómina) — per-entidad, driven off each employee's
// claveEntFed. A company with sucursales has payroll in several states and owes
// ISN to EACH, at that state's rate. So ISN is computed per employee-state, not
// from one company-level entidad. Contract: docs/fiscal-brain-contract.md
// ─────────────────────────────────────────────────────────────────────────────

import type { Entidad, Fundamento } from "../rules";

/** Normalized payroll row the ISN calc reasons over (decoupled from Prisma). */
export interface EmpleadoNomina {
  id: string;
  /** Entidad de prestación del servicio (de claveEntFed); undefined si inválida. */
  entidad?: Entidad;
  /** Remuneraciones gravables del mes (estimadas o reales), MXN. */
  baseMensual: number;
  activo: boolean;
}

/** ISN for one entidad. */
export interface ResultadoIsnEntidad {
  entidad: Entidad;
  numEmpleados: number;
  /** Suma de remuneraciones gravables del mes, MXN. */
  baseMensual: number;
  /** Tasa general resuelta, o null si no hay regla para el estado. */
  tasa: number | null;
  /** ISN estimado = baseMensual × tasa; null si no hay tasa. */
  isn: number | null;
  /** Propagado: la tasa ISN aún no está verificada contra texto primario. */
  verificado: boolean;
  /** Matiz del estado (progresivo / sobretasa) — la estimación puede diferir. */
  nota?: string;
  fundamento?: Fundamento;
}

export interface ResumenIsn {
  porEntidad: ResultadoIsnEntidad[];
  /** Empleados activos con claveEntFed inválida (no clasificables). */
  empleadosSinEntidad: number;
  /** Número de entidades distintas con nómina (>1 ⇒ sucursales). */
  numEntidades: number;
  /** Suma de ISN estimado de las entidades con tasa conocida, MXN. */
  isnTotal: number;
}
