// ─────────────────────────────────────────────────────────────────────────────
// Evidencia de cobro/pago y antigüedad de saldos — lo que comparten cartera,
// compras, panel y el perfil del contacto del módulo HOSPITAL.
//
// La regla es la MISMA que perfil-contacto/cartera del vertical automotriz (y
// que el motor de IVA en flujo): una factura PUE queda pagada en su emisión;
// una PPD se paga por la mejor evidencia disponible — lo conciliado en banco o
// lo amparado por complementos de pago (REPs), lo que sea mayor — para que la
// cartera sea real aunque la empresa no haya cargado bancos. El cruce con los
// REPs va por UUID normalizado (REP en mayúsculas vs PAC en minúsculas).
//
// La antigüedad se mide desde la FECHA del CFDI (días calendario), en los
// cortes que enseña el estado de cuenta por pagador: 0-30 / 31-60 / 61-90 / 90+.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { normalizarUuid, variantesUuid } from "@/lib/fiscal/uuid";

type Db = PrismaClient | Prisma.TransactionClient;

export const r2 = (n: number) => Math.round(n * 100) / 100;

const DIA_MS = 24 * 60 * 60 * 1000;

export type BucketAging = "0-30" | "31-60" | "61-90" | "90+";
export interface Aging {
  "0-30": number;
  "31-60": number;
  "61-90": number;
  "90+": number;
}

export const agingVacio = (): Aging => ({ "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 });

/** Días calendario de `fecha` a `hoy` (sin horas; negativo = futuro). */
export function diasDesde(fecha: Date, hoy: Date): number {
  const a = Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
  const b = Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  return Math.round((b - a) / DIA_MS);
}

export function bucketAging(fecha: Date, hoy: Date): BucketAging {
  const d = diasDesde(fecha, hoy);
  if (d <= 30) return "0-30";
  if (d <= 60) return "31-60";
  if (d <= 90) return "61-90";
  return "90+";
}

export function sumarAging(acc: Aging, bucket: BucketAging, monto: number): Aging {
  acc[bucket] = r2(acc[bucket] + monto);
  return acc;
}

export function acumularAging(acc: Aging, otro: Aging): Aging {
  for (const k of Object.keys(acc) as BucketAging[]) acc[k] = r2(acc[k] + otro[k]);
  return acc;
}

export interface EvidenciaPago {
  /** Cobrado (cliente) o pagado (proveedor). */
  pagado: number;
  saldo: number;
  /** PPD: conciliado sin complemento (>0 = falta REP). PUE no aplica (0). */
  repPendiente: number;
}

/** PUE = total; PPD = max(conciliación, REPs). */
export function pagadoPorEvidencia(f: {
  metodoPago: string | null;
  total: number;
  conciliado: number;
  amparadoRep: number;
}): EvidenciaPago {
  const esPpd = f.metodoPago === "PPD";
  const pagado = esPpd ? r2(Math.max(f.conciliado, f.amparadoRep)) : r2(f.total);
  return {
    pagado,
    saldo: r2(Math.max(0, f.total - pagado)),
    repPendiente: esPpd ? r2(Math.max(0, f.conciliado - f.amparadoRep)) : 0,
  };
}

/** Σ |montoAsignado| de la conciliación bancaria de una factura. */
export function conciliadoDe(detalles: Array<{ montoAsignado: unknown }>): number {
  return r2(detalles.reduce((s, d) => s + Math.abs(Number(d.montoAsignado ?? 0)), 0));
}

/**
 * Importe amparado por complementos de pago hacia cada factura, por UUID
 * normalizado. Una sola consulta para todas las facturas de la vista.
 */
export async function amparadoPorReps(
  db: Db,
  uuids: Iterable<string | null | undefined>
): Promise<Map<string, number>> {
  const lista = [...uuids].filter((u): u is string => !!u);
  const amparado = new Map<string, number>();
  if (lista.length === 0) return amparado;
  const links = await db.pagoDoctoRelacionado.findMany({
    where: { parentUuid: { in: variantesUuid(lista) } },
    select: { parentUuid: true, impPagado: true },
  });
  for (const l of links) {
    const k = normalizarUuid(l.parentUuid);
    amparado.set(k, (amparado.get(k) ?? 0) + Number(l.impPagado ?? 0));
  }
  return amparado;
}

export function amparadoDe(amparado: Map<string, number>, uuid: string | null | undefined): number {
  return uuid ? r2(amparado.get(normalizarUuid(uuid)) ?? 0) : 0;
}
