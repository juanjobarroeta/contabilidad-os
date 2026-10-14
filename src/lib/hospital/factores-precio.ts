// ─────────────────────────────────────────────────────────────────────────────
// Factores de precio de farmacia: el precio de venta de un insumo es su costo
// unitario × el factor del tramo de costo donde cae (lo barato lleva factor
// alto, lo caro bajo). Es la tabla «Factores para medicamentos e insumos» del
// hospital y el «método de actualización de precio: por entrada» de su
// sistema anterior: cada entrada con costo recalcula el precio, salvo en los
// insumos con precio fijo.
//
// La tabla vive en HospConfig.factoresPrecio; null = sin tabla (precio a mano).
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export interface Tramo {
  /** Costo unitario máximo del tramo (incluido); null = sin tope. */
  hasta: number | null;
  factor: number;
}

/** La tabla del hospital («Factores para medicamentos e insumos 2025»). */
export const TABLA_SUGERIDA: Tramo[] = [
  { hasta: 15, factor: 5 },
  { hasta: 30, factor: 4 },
  { hasta: 50, factor: 3 },
  { hasta: 100, factor: 2 },
  { hasta: 200, factor: 2 },
  { hasta: 500, factor: 1.6 },
  { hasta: 4000, factor: 1.5 },
  { hasta: 10000, factor: 1.4 },
  { hasta: 20000, factor: 1.3 },
  { hasta: null, factor: 1.2 },
];

const r2 = (n: number) => Math.round(n * 100) / 100;

export const tablaSchema = z
  .array(z.object({ hasta: z.number().positive().max(100_000_000).nullable(), factor: z.number().min(1, "Un factor menor a 1 vende abajo del costo").max(100) }))
  .min(1, "La tabla lleva al menos un tramo")
  .max(30)
  .superRefine((t, ctx) => {
    t.forEach((x, i) => {
      if (x.hasta == null && i !== t.length - 1) ctx.addIssue({ code: "custom", message: "Sólo el último tramo va sin tope" });
      const prev = t[i - 1]?.hasta;
      if (i > 0 && x.hasta != null && prev != null && x.hasta <= prev) ctx.addIssue({ code: "custom", message: "Los topes van de menor a mayor" });
    });
  });

/** La tabla guardada, o null si no hay (o no es válida). */
export function leerTabla(json: unknown): Tramo[] | null {
  const r = tablaSchema.safeParse(json);
  return r.success ? r.data : null;
}

/** El factor del tramo donde cae el costo; arriba del último tope, el del último tramo. */
export function factorPara(costo: number, tabla: Tramo[]): number {
  for (const t of tabla) if (t.hasta == null || costo <= t.hasta + 1e-9) return t.factor;
  return tabla[tabla.length - 1].factor;
}

export function precioPorFactor(costo: number, tabla: Tramo[]): number {
  return r2(costo * factorPara(costo, tabla));
}

export async function tablaDe(db: Db, companyId: string): Promise<Tramo[] | null> {
  const cfg = await db.hospConfig.findUnique({ where: { companyId }, select: { factoresPrecio: true } });
  return leerTabla(cfg?.factoresPrecio);
}

/**
 * Entró el insumo con este costo: si hay tabla y su precio no es fijo, el
 * precio de venta pasa a costo × factor. Devuelve el precio nuevo o null si
 * no cambió.
 */
export async function precioAlEntrar(db: Db, companyId: string, insumoId: string, costo: number | null): Promise<number | null> {
  if (costo == null || !(costo > 0)) return null;
  const tabla = await tablaDe(db, companyId);
  if (!tabla) return null;
  const precio = precioPorFactor(costo, tabla);
  const n = await db.hospInsumo.updateMany({ where: { id: insumoId, companyId, precioFijo: false }, data: { precioVenta: precio } });
  return n.count ? precio : null;
}

export interface CambioPrecio {
  id: string;
  clave: string;
  nombre: string;
  costo: number;
  factor: number;
  antes: number | null;
  despues: number;
}

/**
 * Recalcula con la tabla todos los insumos activos con costo y sin precio
 * fijo (o sólo los que no tienen precio). Con `aplicar = false` sólo dice qué
 * cambiaría.
 */
export async function recalcularPrecios(db: PrismaClient, companyId: string, tabla: Tramo[], opciones: { aplicar: boolean; soloSinPrecio?: boolean }) {
  const insumos = await db.hospInsumo.findMany({
    where: { companyId, activo: true, precioFijo: false, ultimoCosto: { gt: 0 }, ...(opciones.soloSinPrecio ? { precioVenta: null } : {}) },
    select: { id: true, clave: true, nombre: true, ultimoCosto: true, precioVenta: true },
    orderBy: { clave: "asc" },
  });
  const cambios: CambioPrecio[] = [];
  for (const i of insumos) {
    const costo = Number(i.ultimoCosto);
    const despues = precioPorFactor(costo, tabla);
    const antes = i.precioVenta == null ? null : Number(i.precioVenta);
    if (antes != null && Math.abs(antes - despues) < 0.005) continue;
    cambios.push({ id: i.id, clave: i.clave, nombre: i.nombre, costo, factor: factorPara(costo, tabla), antes, despues });
  }
  if (opciones.aplicar) {
    for (let k = 0; k < cambios.length; k += 200) {
      await db.$transaction(cambios.slice(k, k + 200).map((c) => db.hospInsumo.updateMany({ where: { id: c.id, precioFijo: false }, data: { precioVenta: c.despues } })));
    }
  }
  const sube = cambios.filter((c) => c.antes != null && c.despues > c.antes).length;
  const baja = cambios.filter((c) => c.antes != null && c.despues < c.antes).length;
  return { revisados: insumos.length, cambian: cambios.length, sinPrecioAntes: cambios.filter((c) => c.antes == null).length, sube, baja, muestra: cambios.slice(0, 50) };
}
