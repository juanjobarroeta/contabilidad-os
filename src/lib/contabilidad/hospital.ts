import type { HospCargoCategoria, HospIvaContexto, Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import {
  CLAVES_MOTOR,
  cargarConfigContable,
  claveDeCargo,
  resolverCuenta,
  type ClaveMotor,
  type CuentaResuelta,
} from "../hospital/contabilidad";
import type { CuentaTaller } from "./taller";

/**
 * P3c — el hospital en el libro: el CFDI del paciente partido por categoría.
 *
 * Un CFDI hospitalario ampara de todo en un solo comprobante: noches de
 * estancia, quirófano, estudios, medicinas y los honorarios del cirujano. El
 * motor sabía ponerlo entero en la cuenta de ingresos de siempre. Aquí se
 * parte con lo que el propio módulo ya sabe de cada renglón: los `HospCargo`
 * ligados al CFDI (`invoiceId`) traen categoría y contexto de IVA, y cada uno
 * cae en una CLAVE del motor (ver hospital/contabilidad.ts).
 *
 * Dos decisiones:
 *
 * 1. HONORARIOS NO SON INGRESO. El hospital los cobra al paciente o al pagador
 *    por cuenta del médico (lámina 16: «pasan por la cuenta»). La pierna va a
 *    HONORARIOS_POR_CUENTA_DE_TERCEROS, un pasivo con el médico, no a 401.
 *
 * 2. LOS CARGOS SON PROPORCIÓN, NO IMPORTE. Lo que manda es el subtotal del
 *    CFDI (descuentos, redondeos, renglones agregados al facturar): los cargos
 *    dan la mezcla y se escala, y las piernas suman el subtotal exacto — el
 *    residuo de redondeo lo absorbe la pierna mayor. Sin cargos ligados, null:
 *    el motor sigue como siempre.
 *
 * Todo detrás de `HospConfig.contabilidadActiva`: apagada, el contexto está
 * vacío y el motor no cambia de conducta.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type PiernaHospital = { clave: ClaveMotor; cuenta: CuentaTaller; monto: number };

export interface ContextoHospital {
  activa: boolean;
  /** Importe (sin IVA) de los cargos vivos por clave, por CFDI. */
  cargos: Map<string, Map<ClaveMotor, number>>;
  cuentas: Map<ClaveMotor, CuentaTaller>;
}

export const SIN_HOSPITAL: ContextoHospital = { activa: false, cargos: new Map(), cuentas: new Map() };

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface CargoParaPiernas {
  invoiceId: string | null;
  categoria: HospCargoCategoria;
  ivaContexto?: HospIvaContexto | null;
  ivaTasa?: number | null;
  importe: number;
  cancelado?: boolean;
}

/** Cargos → por CFDI, importe por clave del motor (los cancelados no cuentan). */
export function agruparCargosPorClave(cargos: CargoParaPiernas[]): Map<string, Map<ClaveMotor, number>> {
  const out = new Map<string, Map<ClaveMotor, number>>();
  for (const c of cargos) {
    if (!c.invoiceId || c.cancelado) continue;
    const importe = Number(c.importe);
    if (!(importe > 0)) continue;
    const clave = claveDeCargo({ categoria: c.categoria, ivaContexto: c.ivaContexto, ivaTasa: c.ivaTasa == null ? null : Number(c.ivaTasa) });
    const porClave = out.get(c.invoiceId) ?? new Map<ClaveMotor, number>();
    porClave.set(clave, (porClave.get(clave) ?? 0) + importe);
    out.set(c.invoiceId, porClave);
  }
  return out;
}

/**
 * Reparte el subtotal del CFDI entre las claves en la proporción de los
 * cargos. Null cuando no hay cargos, falta la cuenta de alguna clave o el
 * subtotal es cero: el llamador cae a su cuenta de ingresos de siempre.
 */
export function repartirHospital(
  subtotal: number,
  porClave: Map<ClaveMotor, number> | undefined,
  cuentas: Map<ClaveMotor, CuentaTaller>
): PiernaHospital[] | null {
  if (!porClave || porClave.size === 0 || !(Math.abs(subtotal) > 0.005)) return null;
  let base = 0;
  for (const importe of porClave.values()) if (importe > 0) base += importe;
  if (!(base > 0.005)) return null;

  const piernas: PiernaHospital[] = [];
  for (const clave of CLAVES_MOTOR) {
    const importe = porClave.get(clave) ?? 0;
    if (!(importe > 0.005)) continue;
    const cuenta = cuentas.get(clave);
    if (!cuenta) return null;
    piernas.push({ clave, cuenta, monto: r2((subtotal * importe) / base) });
  }
  if (piernas.length === 0) return null;

  // El redondeo por pierna deja centavos: los absorbe la mayor.
  const residuo = r2(subtotal - piernas.reduce((s, p) => s + p.monto, 0));
  if (Math.abs(residuo) >= 0.005) {
    const mayor = piernas.reduce((m, p) => (Math.abs(p.monto) > Math.abs(m.monto) ? p : m), piernas[0]);
    mayor.monto = r2(mayor.monto + residuo);
  }
  const vivas = piernas.filter((p) => Math.abs(p.monto) >= 0.005);
  return vivas.length > 0 ? vivas : null;
}

const comoCuentaTaller = (c: CuentaResuelta): CuentaTaller => ({ id: c.id, cuentaSAT: c.cuentaSAT, nombre: c.nombre, subcuenta: c.subcuenta, tipo: c.tipo });

/**
 * Todo lo que el motor necesita del hospital para un lote de CFDIs: los
 * cargos ligados agrupados por clave y la cuenta de cada clave usada (se
 * resuelve con el mapa del contador; lo que falte en el catálogo se crea, como
 * hace el motor con sus propios agrupadores). Con la contabilidad apagada el
 * contexto viene vacío — salvo `incluirInactiva`, que usa la previsualización.
 */
export async function cargarContextoHospital(
  companyId: string,
  invoiceIds: string[],
  opts: { db?: Db; incluirInactiva?: boolean } = {}
): Promise<ContextoHospital> {
  if (invoiceIds.length === 0) return SIN_HOSPITAL;
  const db = opts.db ?? prisma;
  const config = await cargarConfigContable(db, companyId);
  if (!config.activa && !opts.incluirInactiva) return SIN_HOSPITAL;

  const cargos = await db.hospCargo.findMany({
    where: { companyId, invoiceId: { in: invoiceIds }, cancelado: false },
    select: { invoiceId: true, categoria: true, ivaContexto: true, ivaTasa: true, importe: true },
  });
  const porInvoice = agruparCargosPorClave(cargos.map((c) => ({ ...c, importe: Number(c.importe), ivaTasa: c.ivaTasa == null ? null : Number(c.ivaTasa) })));

  const usadas = new Set<ClaveMotor>();
  for (const porClave of porInvoice.values()) for (const clave of porClave.keys()) usadas.add(clave);
  const cuentas = new Map<ClaveMotor, CuentaTaller>();
  for (const clave of usadas) cuentas.set(clave, comoCuentaTaller(await resolverCuenta(db, companyId, clave, { config: config.cuentas })));

  return { activa: config.activa, cargos: porInvoice, cuentas };
}

/** Las piernas del hospital para un CFDI (suman el subtotal exacto), o null si no es del hospital. */
export function piernasIngresoHospital(invoiceId: string, subtotal: number, ctx: ContextoHospital): PiernaHospital[] | null {
  return repartirHospital(subtotal, ctx.cargos.get(invoiceId), ctx.cuentas);
}

/**
 * Para el estado de resultados: sólo las piernas de RESULTADOS. La de
 * honorarios es un pasivo y no aporta; un CFDI que fuera puro honorario
 * devuelve [] (no null) para que el llamador no lo cuente como venta.
 */
export function piernasResultadosHospital(invoiceId: string, subtotal: number, ctx: ContextoHospital): PiernaHospital[] | null {
  const piernas = piernasIngresoHospital(invoiceId, subtotal, ctx);
  return piernas ? piernas.filter((p) => p.cuenta.tipo !== "PASIVO") : null;
}
