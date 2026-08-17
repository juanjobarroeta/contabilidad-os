// ─────────────────────────────────────────────────────────────────────────────
// Fase 2 del motor al plan PROPIO: resolución por FAMILIA (AUTOMOTRIZ).
//
// La Fase 1 (resolver-plan-propio) invierte codAgrup → cuenta propia, pero los
// tres códigos de unidades son AMBIGUOS por construcción: el contador declara
// UNA cuenta POR FAMILIA bajo el mismo agrupador (401.01 → 4101-0001…0028,
// 501.01 → 5101-…, 115.04 → 1301-…). La familia de la unidad amparada por el
// CFDI es el dato que desambigua: mismo sufijo en las tres series.
//
// Diseño en dos capas, patrón puro/apply del repo:
//   - indexarCuentasFamilia / cuentaDeFamilia: puras, testeables sin DB.
//   - cargarIndiceFamilia / unidadesAmparadas: las dos consultas.
//
// Conservador como la Fase 1: sufijo duplicado bajo el mismo agrupador →
// ambiguo → null → fallback. Un catálogo sin la estructura por familia (otra
// empresa, CT sin importar) produce un índice vacío y CERO cambio de conducta.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { agruparUnidadesAmparadas, type UnidadResuelta } from "./familia-vehiculo";

/** Códigos del motor que la familia desambigua (los tres de unidades). */
export const MOTOR_VENTAS_UNIDAD = "401.01";
export const MOTOR_COSTO_UNIDAD = "501.01";
export const MOTOR_INVENTARIO_UNIDAD = "115.04";
export const CODIGOS_MOTOR_FAMILIA = [
  MOTOR_VENTAS_UNIDAD,
  MOTOR_COSTO_UNIDAD,
  MOTOR_INVENTARIO_UNIDAD,
] as const;

export interface CuentaFamilia {
  id: string;
  cuentaSAT: string;
  subcuenta: string | null;
  nombre: string;
  tipo: string;
  codAgrup: string | null;
}

export type IndiceFamilia = Map<string, CuentaFamilia | null>;

// El sufijo de familia en la numeración del contador: "4101-0004-0000" → 0004.
const SUFIJO_RE = /^\d{4}-(\d{4})-/;

/**
 * Índice (codAgrup:sufijo) → cuenta propia. Un sufijo repetido bajo el mismo
 * agrupador se marca ambiguo (null) y nunca resuelve — misma filosofía que la
 * inversión de Fase 1: en la duda, fallback, no adivinanza.
 */
export function indexarCuentasFamilia(cuentas: CuentaFamilia[]): IndiceFamilia {
  const idx: IndiceFamilia = new Map();
  for (const c of cuentas) {
    if (!c.codAgrup) continue;
    const m = SUFIJO_RE.exec(c.cuentaSAT);
    if (!m) continue;
    const key = `${c.codAgrup}:${m[1]}`;
    idx.set(key, idx.has(key) ? null : c);
  }
  return idx;
}

/** La cuenta propia de la familia para un código del motor, o null (fallback). */
export function cuentaDeFamilia(
  idx: IndiceFamilia,
  codigoMotor: string,
  sufijo: string,
): CuentaFamilia | null {
  return idx.get(`${codigoMotor}:${sufijo}`) ?? null;
}

/** Las cuentas por familia de la empresa, indexadas. Una consulta por posteo. */
export async function cargarIndiceFamilia(companyId: string): Promise<IndiceFamilia> {
  const cuentas = await prisma.chartAccount.findMany({
    where: { companyId, isActive: true, codAgrup: { in: [...CODIGOS_MOTOR_FAMILIA] } },
    select: { id: true, cuentaSAT: true, subcuenta: true, nombre: true, tipo: true, codAgrup: true },
  });
  return indexarCuentasFamilia(cuentas);
}

/**
 * Unidades amparadas por los CFDIs del período, por lado (venta o compra),
 * agrupadas por invoice con su familia resuelta. Sólo unidades NUEVO destinadas
 * a VENTA: las seminuevas viven en otra serie (1312) y una unidad de uso
 * interno es activo, no inventario — ambas siguen el flujo de siempre.
 */
export async function unidadesAmparadas(
  companyId: string,
  invoiceIds: string[],
  lado: "venta" | "compra",
): Promise<Map<string, UnidadResuelta>> {
  if (invoiceIds.length === 0) return new Map();
  const campo = lado === "venta" ? "ventaInvoiceId" : "compraInvoiceId";
  const unidades = await prisma.vehiculo.findMany({
    where: { companyId, tipo: "NUEVO", uso: "VENTA", [campo]: { in: invoiceIds } },
    select: {
      vin: true,
      marca: true,
      modelo: true,
      version: true,
      costoCompra: true,
      ventaInvoiceId: true,
      compraInvoiceId: true,
    },
  });
  return agruparUnidadesAmparadas(
    unidades.map((u) => ({
      invoiceId: (lado === "venta" ? u.ventaInvoiceId : u.compraInvoiceId)!,
      vin: u.vin,
      marca: u.marca,
      modelo: u.modelo,
      version: u.version,
      costoCompra: u.costoCompra,
    })),
  );
}
