// ─────────────────────────────────────────────────────────────────────────────
// DIOT — carga y agregación por proveedor.
//
// Estaba dentro de la ruta `/api/impuestos/diot`, así que el paquete mensual no
// podía armar la DIOT sin duplicarla. Se movió TAL CUAL: misma consulta, mismo
// helper de flujo, mismo orden y mismos totales. La ruta ahora la llama.
//
// Base de FLUJO DE EFECTIVO (Art. 32 frac. VIII y Art. 1-B LIVA): se reporta el
// IVA EFECTIVAMENTE PAGADO en el mes, no el devengado.
//   - PUE: pagado en el mes de emisión.
//   - PPD: pagado en el mes de la FechaPago de cada REP; los PPD sin REP no se
//     reportan (aún no están pagados).
// La agregación pesada vive en `operacionesEgresoFlujo`, compartida con el
// motor mensual — aquí sólo se agrupa por RFC.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { efosRfcsBloqueados } from "@/lib/fiscal/efos/service";
import {
  operacionesEgresoFlujo,
  type EgresoDelMes,
  type PpdParentEgreso,
} from "@/lib/fiscal/iva-flujo";

/** 04 = Nacional · 05 = Extranjero · 15 = Global (sin RFC). */
export type TipoTercero = "04" | "05" | "15";

export interface ProveedorDiotRow {
  rfc: string;
  razonSocial: string;
  tipoTercero: TipoTercero;
  /** Operaciones pagadas en el mes (facturas PUE + pagos de REP). */
  operaciones: number;
  valorActosGravados16: number;
  ivaTrasladadoPagado16: number;
  valorActosGravados0: number;
  valorActosExentos: number;
  ivaNoAcreditable: number;
  ivaRetenido: number;
  totalPagado: number;
}

export interface TotalesDiot {
  operaciones: number;
  valorActosGravados16: number;
  ivaTrasladadoPagado16: number;
  valorActosGravados0: number;
  valorActosExentos: number;
  ivaNoAcreditable: number;
  ivaRetenido: number;
  totalPagado: number;
  proveedores: number;
}

/** RFC genérico de operaciones con público en general. */
const RFC_PUBLICO = "XAXX010101000";
/** RFC genérico de residentes en el extranjero. */
const RFC_EXTRANJERO = "XEXX010101000";

export function tipoTerceroDeRfc(rfc: string): TipoTercero {
  if (rfc === RFC_EXTRANJERO || rfc.length < 12) return "05";
  if (rfc === RFC_PUBLICO) return "15";
  return "04";
}

/** Agrupa por RFC las operaciones pagadas del mes. PURO. */
export function agruparPorProveedor(
  operaciones: ReturnType<typeof operacionesEgresoFlujo>
): ProveedorDiotRow[] {
  const byRfc = new Map<string, ProveedorDiotRow>();

  for (const op of operaciones) {
    const rfc = op.rfc ?? RFC_PUBLICO;
    const razonSocial = op.razonSocial ?? "PUBLICO EN GENERAL";

    if (!byRfc.has(rfc)) {
      byRfc.set(rfc, {
        rfc,
        razonSocial,
        tipoTercero: tipoTerceroDeRfc(rfc),
        operaciones: 0,
        valorActosGravados16: 0,
        ivaTrasladadoPagado16: 0,
        valorActosGravados0: 0,
        valorActosExentos: 0,
        ivaNoAcreditable: 0,
        ivaRetenido: 0,
        totalPagado: 0,
      });
    }

    const row = byRfc.get(rfc)!;
    row.operaciones++;
    row.totalPagado += op.totalPagado;
    row.valorActosGravados16 += op.base16Pagada;
    row.ivaTrasladadoPagado16 += op.ivaAcreditable;
    row.valorActosGravados0 += op.base0Pagada;
    row.valorActosExentos += op.exentosPagados;
    row.ivaNoAcreditable += op.ivaNoAcreditable;
    row.ivaRetenido += op.ivaRetenido;
  }

  // Mayor IVA acreditable primero: es el orden en el que se revisa.
  return Array.from(byRfc.values()).sort(
    (a, b) => b.ivaTrasladadoPagado16 - a.ivaTrasladadoPagado16
  );
}

export function totalesDiot(rows: ProveedorDiotRow[]): TotalesDiot {
  const suma = (f: (r: ProveedorDiotRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  return {
    operaciones: suma((r) => r.operaciones),
    valorActosGravados16: suma((r) => r.valorActosGravados16),
    ivaTrasladadoPagado16: suma((r) => r.ivaTrasladadoPagado16),
    valorActosGravados0: suma((r) => r.valorActosGravados0),
    valorActosExentos: suma((r) => r.valorActosExentos),
    ivaNoAcreditable: suma((r) => r.ivaNoAcreditable),
    ivaRetenido: suma((r) => r.ivaRetenido),
    totalPagado: suma((r) => r.totalPagado),
    proveedores: rows.length,
  };
}

const taxesSelect = {
  select: { tipo: true, factor: true, tasa: true, base: true, importe: true, retencion: true },
} as const;

/** Proveedores del mes con su desglose de IVA sobre base de flujo. */
export async function cargarProveedoresDiot(
  companyId: string,
  year: number,
  month: number
): Promise<ProveedorDiotRow[]> {
  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month, 1);

  // Proveedores 69-B definitivos: su IVA NO es acreditable (Art. 69-B CFF) —
  // la operación sí se reporta, pero el IVA va como no acreditable.
  const efosBloqueados = await efosRfcsBloqueados(companyId);
  const esEfos = (rfc?: string | null) =>
    efosBloqueados.size > 0 && !!rfc && efosBloqueados.has(rfc.toUpperCase().trim());

  // 1) Egresos EMITIDOS en el mes: sólo los PUE cuentan (pagados por emisión).
  //    Los PPD se filtran dentro del helper — entran únicamente vía REP.
  // 2) Pagos de REP con FechaPago dentro del mes.
  const [egresosDelMes, repLinksDelMes] = await Promise.all([
    prisma.invoice.findMany({
      where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: from, lt: to } },
      select: {
        metodoPago: true,
        subtotal: true,
        total: true,
        totalImpuestos: true,
        ivaNoAcreditable: true,
        taxes: taxesSelect,
        customer: { select: { rfc: true, razonSocial: true } },
      },
    }),
    prisma.pagoDoctoRelacionado.findMany({
      where: {
        fechaPago: { gte: from, lt: to },
        pagoInvoice: { companyId, tipo: "PAGO", status: "STAMPED" },
      },
      select: { parentUuid: true, impPagado: true, ivaTrasladado: true, ivaDerivado: true },
    }),
  ]);

  // 3) Facturas madre PPD (EGRESO) de esos pagos — mismos filtros que el motor.
  const parentUuids = [...new Set(repLinksDelMes.map((l) => l.parentUuid))];
  const ppdParentsRaw = parentUuids.length
    ? await prisma.invoice.findMany({
        where: {
          companyId,
          tipo: "EGRESO",
          uuid: { in: parentUuids },
          metodoPago: "PPD",
          status: "STAMPED",
        },
        select: {
          uuid: true,
          metodoPago: true,
          subtotal: true,
          total: true,
          totalImpuestos: true,
          ivaNoAcreditable: true,
          taxes: taxesSelect,
          customer: { select: { rfc: true, razonSocial: true } },
        },
      })
    : [];

  const egresos: EgresoDelMes[] = egresosDelMes.map((inv) => ({
    metodoPago: inv.metodoPago,
    subtotal: inv.subtotal,
    total: inv.total,
    totalImpuestos: inv.totalImpuestos,
    taxes: inv.taxes,
    ivaNoAcreditable: inv.ivaNoAcreditable || esEfos(inv.customer?.rfc),
    rfc: inv.customer?.rfc ?? null,
    razonSocial: inv.customer?.razonSocial ?? null,
  }));

  const ppdParents: PpdParentEgreso[] = ppdParentsRaw
    .filter((p) => p.uuid != null)
    .map((p) => ({
      uuid: p.uuid!,
      metodoPago: p.metodoPago,
      subtotal: p.subtotal,
      total: p.total,
      totalImpuestos: p.totalImpuestos,
      taxes: p.taxes,
      ivaNoAcreditable: p.ivaNoAcreditable || esEfos(p.customer?.rfc),
      rfc: p.customer?.rfc ?? null,
      razonSocial: p.customer?.razonSocial ?? null,
    }));

  return agruparPorProveedor(
    operacionesEgresoFlujo({ egresosDelMes: egresos, repLinksDelMes, ppdParents })
  );
}
