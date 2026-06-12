// ISN (Impuesto Sobre Nómina) — per-entidad, sucursales-aware.
export * from "./types";
export { calcularIsnPorEntidad } from "./calc";
export { auditarIsn } from "./audit";
export {
  empleadoNominaDesde,
  agregarNominaPorEmpleado,
  DIAS_MES,
  type EmployeeLike,
  type PayrollItemLike,
} from "./from-prisma";
