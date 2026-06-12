// ISN (Impuesto Sobre Nómina) — per-entidad, sucursales-aware.
export * from "./types";
export { calcularIsnPorEntidad } from "./calc";
export { auditarIsn } from "./audit";
export { empleadoNominaDesde, DIAS_MES, type EmployeeLike } from "./from-prisma";
