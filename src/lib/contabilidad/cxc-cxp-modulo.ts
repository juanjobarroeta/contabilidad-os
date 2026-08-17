// ─────────────────────────────────────────────────────────────────────────────
// Fase 2b del plan propio: la CxC y la CxP resuelven por MÓDULO.
//
// El gigante 105.01 (clientes) no tiene UNA cuenta general — la CE lo reparte
// (FI, unidades, intercambios, refacciones, servicio) sin dominante, así que
// un override fabricaría coincidencia. Lo que sí hay es el DATO: el motor sabe
// qué vende cada CFDI (la unidad ligada, los movimientos de refacción, la
// venta de servicio), y el contador tiene UNA CxC por módulo. Misma filosofía
// que la familia (Fase 2): resolver con el dato, fallback sin él.
//
// La regla de oro: la provisión y su liquidación viajan JUNTAS. El CFDI carga
// la CxC del módulo y el movimiento bancario que lo cobra abona LA MISMA — por
// eso el lado banco resuelve mirando la factura conciliada, no el período.
// Igual para nómina: el neto provisiona en ACREEDORES (205.02 → 2207-0001 vía
// Fase 1) y el pago bancario liquida acreedores, no proveedores — que era el
// defecto que el override de CXP PLANTA volvió visible.
//
// Fuera del alcance, a propósito: intercambios (1210 — no hay señal en el CFDI
// que los identifique) y seminuevas (1211 tiene DOS cuentas, IVA/NO IVA — la
// ambigüedad cae al fallback, que es la conducta correcta hasta que el
// contador decida).
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";

/** Series CxC del plan del contador, bajo el agrupador 105.01. */
export const CXC_UNIDADES = { codigo: "105.01", serie: "1206" } as const;
export const CXC_REFACCIONES = { codigo: "105.01", serie: "1217" } as const;
export const CXC_SERVICIO = { codigo: "105.01", serie: "1214" } as const;

export interface CuentaSerie {
  id: string;
  cuentaSAT: string;
  nombre: string;
  codAgrup: string | null;
}

/**
 * La cuenta ÚNICA de una serie bajo un agrupador, o null. Dos activas de la
 * misma serie (el caso 1211 IVA/NO IVA) = ambigua = fallback, no adivinanza.
 */
export function cuentaDeSerie(
  cuentas: CuentaSerie[],
  motor: { codigo: string; serie: string },
): CuentaSerie | null {
  const hits = cuentas.filter(
    (c) => c.codAgrup === motor.codigo && c.cuentaSAT.startsWith(`${motor.serie}-`),
  );
  return hits.length === 1 ? hits[0] : null;
}

export interface CuentasCxc {
  unidades: CuentaSerie | null;
  refacciones: CuentaSerie | null;
  servicio: CuentaSerie | null;
}

/** Las tres CxC de módulo de la empresa (una consulta). */
export async function cargarCuentasCxc(companyId: string): Promise<CuentasCxc> {
  const cuentas = await prisma.chartAccount.findMany({
    where: { companyId, isActive: true, codAgrup: CXC_UNIDADES.codigo },
    select: { id: true, cuentaSAT: true, nombre: true, codAgrup: true },
  });
  return {
    unidades: cuentaDeSerie(cuentas, CXC_UNIDADES),
    refacciones: cuentaDeSerie(cuentas, CXC_REFACCIONES),
    servicio: cuentaDeSerie(cuentas, CXC_SERVICIO),
  };
}

/** Qué vende un CFDI de ingreso, para elegir su CxC. */
export type ModuloCxc = "unidades" | "refacciones" | "servicio";

export interface ConjuntosModulo {
  unidades: Set<string>;
  refacciones: Set<string>;
  servicios: Set<string>;
}

/**
 * El módulo de un invoice. La unidad manda: un CFDI que ampara una unidad es
 * venta de unidad aunque traiga accesorios o mano de obra en otras líneas.
 */
export function moduloDeInvoice(invoiceId: string, c: ConjuntosModulo): ModuloCxc | null {
  if (c.unidades.has(invoiceId)) return "unidades";
  if (c.refacciones.has(invoiceId)) return "refacciones";
  if (c.servicios.has(invoiceId)) return "servicio";
  return null;
}

/**
 * Qué invoices del lote venden qué. `unidades` sólo NUEVO/VENTA — las
 * seminuevas viven en 1211 (ambigua) y siguen el flujo de siempre.
 */
export async function conjuntosModulo(
  companyId: string,
  invoiceIds: string[],
): Promise<ConjuntosModulo> {
  if (invoiceIds.length === 0) {
    return { unidades: new Set(), refacciones: new Set(), servicios: new Set() };
  }
  const [unidades, refacciones, servicios] = await Promise.all([
    prisma.vehiculo.findMany({
      where: { companyId, tipo: "NUEVO", uso: "VENTA", ventaInvoiceId: { in: invoiceIds } },
      select: { ventaInvoiceId: true },
    }),
    prisma.refaccionMovimiento.findMany({
      where: { invoiceId: { in: invoiceIds } },
      select: { invoiceId: true },
    }),
    prisma.servicioVenta.findMany({
      where: { invoiceId: { in: invoiceIds } },
      select: { invoiceId: true },
    }),
  ]);
  return {
    unidades: new Set(unidades.map((u) => u.ventaInvoiceId!)),
    refacciones: new Set(refacciones.map((r) => r.invoiceId!).filter(Boolean)),
    servicios: new Set(servicios.map((s) => s.invoiceId!).filter(Boolean)),
  };
}

/**
 * El lado banco: la liquidación resuelve mirando LA FACTURA conciliada — que
 * puede ser de cualquier período, no sólo el que se postea. NOMINA liquida
 * acreedores; los módulos, su CxC. Varias facturas conciliadas de módulos
 * DISTINTOS → fallback (no se reparte a ciegas).
 */
export type KindLiquidacion = "NOMINA" | ModuloCxc | null;

export async function kindPorInvoice(
  companyId: string,
  invoiceIds: string[],
): Promise<Map<string, KindLiquidacion>> {
  const out = new Map<string, KindLiquidacion>();
  if (invoiceIds.length === 0) return out;
  const [nominas, conjuntos] = await Promise.all([
    prisma.invoice.findMany({
      where: { companyId, id: { in: invoiceIds }, tipo: "NOMINA" },
      select: { id: true },
    }),
    conjuntosModulo(companyId, invoiceIds),
  ]);
  for (const id of invoiceIds) out.set(id, moduloDeInvoice(id, conjuntos));
  for (const n of nominas) out.set(n.id, "NOMINA");
  return out;
}

/** El kind común de un grupo de facturas conciliadas, o null si difieren. */
export function kindComun(
  kinds: Map<string, KindLiquidacion>,
  invoiceIds: string[],
): KindLiquidacion {
  if (invoiceIds.length === 0) return null;
  const primero = kinds.get(invoiceIds[0]) ?? null;
  if (primero == null) return null;
  return invoiceIds.every((id) => kinds.get(id) === primero) ? primero : null;
}
