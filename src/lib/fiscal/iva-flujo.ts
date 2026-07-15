// ─────────────────────────────────────────────────────────────────────────────
// IVA en FLUJO DE EFECTIVO (Art. 1-B LIVA) — helpers PUROS compartidos entre el
// motor mensual (`computeTaxPosition`, src/lib/impuestos.ts) y la DIOT
// (Art. 32 fracc. VIII LIVA, /api/impuestos/diot).
//
// Regla de flujo para EGRESOS (IVA acreditable = "efectivamente pagado",
// Arts. 1-B y 5 fracc. III LIVA):
//   - PUE: se considera pagado en el mes de EMISIÓN de la factura.
//   - PPD: se considera pagado en el mes de la FechaPago de cada pago del
//     complemento de pago (REP) recibido — cada pago del REP es una operación
//     independiente. Un PPD sin REP todavía NO está pagado: no causa IVA
//     acreditable ni se reporta en la DIOT de ningún mes.
//
// El IVA de cada pago PPD proviene del propio REP (complemento 2.0, valor
// firme) o se prorratea de la factura madre para REP legacy 1.0 sin desglose.
//
// Todas las funciones son puras y reciben datos ya consultados (sin prisma)
// para poder probarlas sin mocks — convención del repo.
// ─────────────────────────────────────────────────────────────────────────────

import { normalizarUuid } from "./uuid";

export type InvoiceLike = {
  taxes: { tipo: string; retencion: boolean; importe: number }[];
  totalImpuestos: number | null;
};

/**
 * IVA trasladado (no retenido) de una factura, a partir de sus filas de
 * impuesto; para facturas legacy sin desglose cae a `totalImpuestos`.
 */
export function ivaTrasladadoDe(inv: InvoiceLike): number {
  const ivaTaxes = inv.taxes.filter((t) => t.tipo === "IVA" && !t.retencion);
  return ivaTaxes.length > 0
    ? ivaTaxes.reduce((s, t) => s + t.importe, 0)
    : (inv.totalImpuestos ?? 0);
}

/**
 * IVA of a single REP payment toward a parent invoice. Uses the firm
 * payment-level IVA from complemento 2.0 when present; otherwise (legacy 1.0
 * or 2.0 without desglose) prorates the parent invoice's IVA by the fraction
 * paid in this REP.
 */
export function repIvaTrasladadoDe(
  link: { impPagado: number | null; ivaTrasladado: number | null; ivaDerivado: boolean },
  parent: InvoiceLike & { total: number }
): number {
  if (link.ivaTrasladado != null && !link.ivaDerivado) return link.ivaTrasladado;
  const parentIva = ivaTrasladadoDe(parent);
  if (parent.total <= 0 || link.impPagado == null) return 0;
  return parentIva * (link.impPagado / parent.total);
}

// ─────────────────────────────────────────────────────────────────────────────
// Clasificación de bases: tasa 16% vs tasa 0% vs exento.
//
// Para la DIOT NO es lo mismo tasa 0% que exento (misma distinción que la
// proporción de acreditamiento del Art. 5 fracc. V LIVA, ver
// `calcularActosDelPeriodo` en src/lib/fiscal/iva.ts):
//   - Un traslado de IVA con TipoFactor=Tasa/Cuota y TasaOCuota 0 es un acto
//     GRAVADO a tasa 0% (campo "valor de actos gravados a tasa 0%").
//   - Un traslado con TipoFactor=Exento — o una factura cuyos conceptos NO
//     llevan traslado de IVA — es un acto EXENTO.
//
// Cuando el dato no alcanza para distinguir (facturas legacy sin filas de
// impuesto ni base) se clasifica CONSERVADORAMENTE: si hay IVA (>0) el
// subtotal se asume gravado a 16%; si no hay IVA, se asume exento (no se
// reclama base gravada a 0% que no consta, y el CFDI sí se reporta).
// ─────────────────────────────────────────────────────────────────────────────

export interface EgresoConTaxes {
  subtotal: number;
  total: number;
  totalImpuestos: number | null;
  taxes: {
    tipo: string;
    factor: string;
    tasa: number;
    base: number | null;
    importe: number;
    retencion: boolean;
  }[];
}

export interface BasesIvaEgreso {
  /** Valor de actos gravados a tasa 16% (o tasa/cuota > 0). */
  base16: number;
  /** Valor de actos gravados a tasa 0%. */
  base0: number;
  /** Valor de actos exentos (TipoFactor=Exento o sin traslado de IVA). */
  exentos: number;
  /** IVA trasladado de la factura (misma cifra que usa el motor mensual). */
  iva: number;
  /** IVA que retuvimos al proveedor. */
  ivaRetenido: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Clasifica las bases de una factura de EGRESO en gravado 16% / gravado 0% /
 * exento usando sus filas de impuesto (InvoiceTax, parseadas del nodo
 * Impuestos del CFDI). Cifras DEVENGADAS de la factura completa — el llamador
 * las prorratea para pagos parciales PPD.
 */
export function clasificarBasesIvaEgreso(inv: EgresoConTaxes): BasesIvaEgreso {
  const ivaRows = inv.taxes.filter((t) => t.tipo === "IVA" && !t.retencion);
  const ivaRetenido = inv.taxes
    .filter((t) => t.tipo === "IVA" && t.retencion)
    .reduce((s, t) => s + t.importe, 0);
  // Mismo cálculo de IVA que el motor mensual (incluye el fallback legacy a
  // totalImpuestos) para que DIOT y computeTaxPosition cuadren peso a peso.
  const iva = ivaTrasladadoDe(inv);

  let base16 = 0;
  let base0 = 0;
  let exentos = 0;

  const conBase = ivaRows.filter((r) => r.base != null);
  if (conBase.length > 0) {
    for (const row of conBase) {
      if (row.factor === "EXENTO") exentos += row.base!;
      else if (row.tasa > 0) base16 += row.base!;
      // TipoFactor Tasa/Cuota con TasaOCuota 0 → acto GRAVADO a tasa 0%.
      else base0 += row.base!;
    }
  } else if (ivaRows.length > 0) {
    // Filas sin Base (sintéticas legacy o CFDI 3.3 sin Base a nivel
    // comprobante): se clasifica el subtotal completo por la mejor señal
    // disponible — conservador y documentado.
    if (iva > 0) base16 = inv.subtotal;
    else if (ivaRows.every((r) => r.factor === "EXENTO")) exentos = inv.subtotal;
    else base0 = inv.subtotal; // traslado a tasa 0 sin base
  } else {
    // Sin desglose de IVA en absoluto.
    if (iva > 0) base16 = inv.subtotal; // legacy: totalImpuestos > 0 sin filas
    // Conservador: sin traslado de IVA se reporta como EXENTO. El dato no
    // permite separar "exento" de "no objeto" en estas filas legacy.
    else exentos = inv.subtotal;
  }

  return {
    base16: r2(base16),
    base0: r2(base0),
    exentos: r2(exentos),
    iva: r2(iva),
    ivaRetenido: r2(ivaRetenido),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Operaciones de egreso del mes en flujo de efectivo (insumo de la DIOT).
// ─────────────────────────────────────────────────────────────────────────────

export interface EgresoDelMes extends EgresoConTaxes {
  /** "PUE" | "PPD" (catálogo SAT). Sólo los PUE cuentan por emisión. */
  metodoPago: string;
  /**
   * IVA marcado como NO acreditable: bandera manual del contador
   * (Invoice.ivaNoAcreditable, p. ej. PPD no pagado / Art. 5-I) o proveedor
   * 69-B definitivo (Art. 69-B CFF) — el llamador ya lo resolvió.
   */
  ivaNoAcreditable?: boolean;
  rfc: string | null;
  razonSocial: string | null;
}

export interface PpdParentEgreso extends EgresoDelMes {
  uuid: string;
}

export interface RepLinkPago {
  parentUuid: string;
  impPagado: number | null;
  ivaTrasladado: number | null;
  ivaDerivado: boolean;
}

export interface OperacionEgresoFlujo {
  rfc: string | null;
  razonSocial: string | null;
  /** PUE = factura pagada por emisión; REP = pago de complemento sobre PPD. */
  origen: "PUE" | "REP";
  /** Monto efectivamente pagado en el mes (total PUE / ImpPagado del REP). */
  totalPagado: number;
  base16Pagada: number;
  base0Pagada: number;
  exentosPagados: number;
  /** IVA acreditable del pago — cuadra con `iva.acreditableBruto` del motor. */
  ivaAcreditable: number;
  /** IVA pagado pero NO acreditable (bandera manual o 69-B) — informativo. */
  ivaNoAcreditable: number;
  ivaRetenido: number;
}

/**
 * Operaciones con proveedores EFECTIVAMENTE PAGADAS en el mes, en flujo de
 * efectivo (Art. 1-B LIVA) — la base de la DIOT (Art. 32 fracc. VIII LIVA):
 *
 *   - `egresosDelMes`: TODOS los CFDI de egreso EMITIDOS en el mes; aquí sólo
 *     cuentan los PUE (pagados por emisión). Los PPD del mes SIN pago se
 *     excluyen — entrarán a la DIOT del mes en que su REP diga que se pagaron.
 *   - `repLinksDelMes`: pagos de REP con FechaPago dentro del mes.
 *   - `ppdParents`: facturas madre (PPD, EGRESO) de esos pagos. Un pago cuyo
 *     padre no está aquí (no-PPD, otro tipo, desconocido) se ignora — mismo
 *     criterio que computeTaxPosition.
 *
 * Para pagos parciales, las bases y el IVA retenido se prorratean por la
 * fracción pagada (ImpPagado/total); el IVA acreditable usa el desglose firme
 * del REP 2.0 cuando existe (repIvaTrasladadoDe). La suma de `ivaAcreditable`
 * del mes cuadra con `iva.acreditableBruto` de computeTaxPosition (el motor
 * después aplica la proporción del Art. 5-V, que es global, no por proveedor).
 */
export function operacionesEgresoFlujo(params: {
  egresosDelMes: EgresoDelMes[];
  repLinksDelMes: RepLinkPago[];
  ppdParents: PpdParentEgreso[];
}): OperacionEgresoFlujo[] {
  const { egresosDelMes, repLinksDelMes, ppdParents } = params;
  const operaciones: OperacionEgresoFlujo[] = [];

  // PUE: causa (se paga) el mes de emisión — misma regla que el motor mensual.
  for (const inv of egresosDelMes) {
    if (inv.metodoPago !== "PUE") continue; // PPD sólo entra vía REP
    const bases = clasificarBasesIvaEgreso(inv);
    operaciones.push({
      rfc: inv.rfc,
      razonSocial: inv.razonSocial,
      origen: "PUE",
      totalPagado: r2(inv.total),
      base16Pagada: bases.base16,
      base0Pagada: bases.base0,
      exentosPagados: bases.exentos,
      ivaAcreditable: inv.ivaNoAcreditable ? 0 : bases.iva,
      ivaNoAcreditable: inv.ivaNoAcreditable ? bases.iva : 0,
      ivaRetenido: bases.ivaRetenido,
    });
  }

  // PPD: cada pago de REP con FechaPago en el mes es una operación pagada.
  // Empate por UUID normalizado: el REP escribe IdDocumento en MAYÚSCULAS y
  // las facturas timbradas vía PAC se guardan en minúsculas — un empate
  // sensible a mayúsculas descartaba pagos reales como "padre desconocido".
  const byUuid = new Map(ppdParents.map((p) => [normalizarUuid(p.uuid), p]));
  for (const link of repLinksDelMes) {
    const parent = byUuid.get(normalizarUuid(link.parentUuid));
    // Padre desconocido o no-PPD: fuera (mismo criterio que computeTaxPosition).
    if (!parent || parent.metodoPago !== "PPD") continue;
    const iva = r2(repIvaTrasladadoDe(link, parent));
    // Fracción pagada para prorratear bases y retenciones. Sin ImpPagado o con
    // total inválido no hay base que reportar (el IVA firme del REP 2.0, si
    // existe, se conserva — igual que el motor).
    const fraccion =
      parent.total > 0 && link.impPagado != null ? link.impPagado / parent.total : 0;
    if (fraccion === 0 && iva === 0) continue; // pago sin monto ni IVA: nada que reportar
    const bases = clasificarBasesIvaEgreso(parent);
    operaciones.push({
      rfc: parent.rfc,
      razonSocial: parent.razonSocial,
      origen: "REP",
      totalPagado: r2(link.impPagado ?? 0),
      base16Pagada: r2(bases.base16 * fraccion),
      base0Pagada: r2(bases.base0 * fraccion),
      exentosPagados: r2(bases.exentos * fraccion),
      ivaAcreditable: parent.ivaNoAcreditable ? 0 : iva,
      ivaNoAcreditable: parent.ivaNoAcreditable ? iva : 0,
      // El REP no desglosa retenciones: se prorratea la de la factura madre
      // por la fracción pagada (mismo criterio que el 10% ISR en el motor).
      ivaRetenido: r2(bases.ivaRetenido * fraccion),
    });
  }

  return operaciones;
}
