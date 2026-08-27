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

/**
 * Códigos del motor que la familia desambigua, CON su serie base. El sufijo
 * solo NO alcanza: el contador repite la familia en varias series bajo el
 * MISMO agrupador (4101 nuevos / 4111 demo / 4131 intercambio / 4141 flotilla,
 * todas 401.01; 1312 usados junto a 1301, ambas 115.04). Medido en MARGOM: con
 * el índice por (agrupador:sufijo) las ventas salían TODAS ambiguas — cero
 * resoluciones a 4101 y cero costos de venta en 23 períodos re-posteados.
 *
 * El flujo de unidades NUEVAS de este módulo apunta a la serie base — la misma
 * 1301 que ya fijaba el script de divergencia. Demo/flotilla/intercambio son
 * refinamiento posterior (override del contador). Una empresa sin estas series
 * no produce candidatas → fallback → cero cambio de conducta.
 */
export const MOTOR_VENTAS_UNIDAD = { codigo: "401.01", serie: "4101" } as const;
export const MOTOR_COSTO_UNIDAD = { codigo: "501.01", serie: "5101" } as const;
export const MOTOR_INVENTARIO_UNIDAD = { codigo: "115.04", serie: "1301" } as const;
/** FASE 2g — la unidad que se va al costo vive en su propia serie. Ver intercambio.ts. */
export const MOTOR_VENTAS_INTERCAMBIO = { codigo: "401.01", serie: "4131" } as const;
export const MOTOR_COSTO_INTERCAMBIO = { codigo: "501.01", serie: "5131" } as const;
export const CODIGOS_MOTOR_FAMILIA = [
  MOTOR_VENTAS_UNIDAD.codigo,
  MOTOR_COSTO_UNIDAD.codigo,
  MOTOR_INVENTARIO_UNIDAD.codigo,
] as const;

export type MotorFamilia = { codigo: string; serie: string };

export interface CuentaFamilia {
  id: string;
  cuentaSAT: string;
  subcuenta: string | null;
  nombre: string;
  tipo: string;
  codAgrup: string | null;
}

export type IndiceFamilia = Map<string, CuentaFamilia | null>;

// Serie y sufijo de familia en la numeración del contador: "4101-0004-0000".
const SERIE_SUFIJO_RE = /^(\d{4})-(\d{4})-/;

/**
 * Índice (codAgrup:serie:sufijo) → cuenta propia. Una llave repetida se marca
 * ambigua (null) y nunca resuelve — misma filosofía que la inversión de
 * Fase 1: en la duda, fallback, no adivinanza. El codAgrup sigue en la llave:
 * la cuenta debe estar DECLARADA bajo el agrupador que el motor emite, no
 * basta con que el número se parezca.
 */
export function indexarCuentasFamilia(cuentas: CuentaFamilia[]): IndiceFamilia {
  const idx: IndiceFamilia = new Map();
  for (const c of cuentas) {
    if (!c.codAgrup) continue;
    const m = SERIE_SUFIJO_RE.exec(c.cuentaSAT);
    if (!m) continue;
    const key = `${c.codAgrup}:${m[1]}:${m[2]}`;
    idx.set(key, idx.has(key) ? null : c);
  }
  return idx;
}

/** La cuenta propia de la familia para un código del motor, o null (fallback). */
export function cuentaDeFamilia(
  idx: IndiceFamilia,
  motor: MotorFamilia,
  sufijo: string,
): CuentaFamilia | null {
  return idx.get(`${motor.codigo}:${motor.serie}:${sufijo}`) ?? null;
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
      precioVenta: true,
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
      costoCompra: Number(u.costoCompra),
      precioVenta: u.precioVenta === null ? null : Number(u.precioVenta),
    })),
  );
}
