import { prisma } from "./prisma";
import { sumIsrPagar } from "./isr-provisional";
import { detectResicoKind, calcularIsrResicoPf } from "./resico";
import { calcularIsrProvisionalPf } from "./fiscal/isr-pf";

// ─────────────────────────────────────────────────────────────────────────────
// Monthly tax position (IVA + ISR provisional) computed from synced CFDIs.
//
// Extracted from the /api/impuestos route so the same logic powers the web
// page, the AI/WhatsApp tools, and the dashboard — one source of truth.
//
// IVA is on FLUJO DE EFECTIVO (cash basis, Art. 1-B LIVA):
//   - PUE: causa el mes de emisión (se asume pagada)
//   - PPD: causa el mes del PAGO, tomado del Complemento de Pago (REP). El IVA
//     trasladado proviene del propio REP (complemento 2.0, valor firme) o se
//     prorratea de la factura madre para REP legacy 1.0 sin desglose. La
//     FechaPago del REP define el periodo — NO el match bancario. Un cobro PPD
//     sin REP todavía no causa IVA (lo detecta el recordatorio de complementos).
// ISR provisional uses the Art. 14 cumulative formula with the coeficiente de
// utilidad (manual override → prior-year calculated → none).
// ─────────────────────────────────────────────────────────────────────────────

type InvoiceLike = {
  taxes: { tipo: string; retencion: boolean; importe: number }[];
  totalImpuestos: number | null;
};

function ivaTrasladado(inv: InvoiceLike): number {
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
function repIvaTrasladado(
  link: { impPagado: number | null; ivaTrasladado: number | null; ivaDerivado: boolean },
  parent: InvoiceLike & { total: number }
): number {
  if (link.ivaTrasladado != null && !link.ivaDerivado) return link.ivaTrasladado;
  const parentIva = ivaTrasladado(parent);
  if (parent.total <= 0 || link.impPagado == null) return 0;
  return parentIva * (link.impPagado / parent.total);
}

/**
 * Cumulative income actually collected and deductions actually paid in
 * [from, to) — the FLUJO DE EFECTIVO base personas físicas need (Art. 106).
 * PUE is treated as collected/paid on emission; PPD by REP payment (FechaPago),
 * taking the subtotal-equivalent of each payment (impPagado × subtotal/total).
 *
 * Also accumulates `isrRetenidoCobrado`: the 10% ISR withheld by personas
 * morales on the PF's INGRESO (Art. 106) — credited on the SAME flujo basis as
 * the income, so a retención is only acreditada once its income is collected
 * (PUE on emission; PPD prorated by the fraction paid). The REP carries no ISR
 * breakdown, so for PPD the parent invoice's retención is prorated by
 * impPagado/total, mirroring the income proration.
 */
async function flujoEfectivoAcum(
  companyId: string,
  from: Date,
  to: Date
): Promise<{ ingresosCobrados: number; deduccionesPagadas: number; isrRetenidoCobrado: number }> {
  const [puIngreso, puEgreso, puIngresoIsrRet, repLinks] = await Promise.all([
    prisma.invoice.aggregate({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", metodoPago: "PUE", fecha: { gte: from, lt: to } },
      _sum: { subtotal: true },
    }),
    prisma.invoice.aggregate({
      where: { companyId, tipo: "EGRESO", status: "STAMPED", metodoPago: "PUE", fecha: { gte: from, lt: to } },
      _sum: { subtotal: true },
    }),
    // ISR retenido (10% Art. 106) on PUE INGRESO — fully cobrado on emission.
    prisma.invoiceTax.aggregate({
      where: {
        tipo: "ISR",
        retencion: true,
        invoice: { companyId, tipo: "INGRESO", status: "STAMPED", metodoPago: "PUE", fecha: { gte: from, lt: to } },
      },
      _sum: { importe: true },
    }),
    prisma.pagoDoctoRelacionado.findMany({
      where: { fechaPago: { gte: from, lt: to }, pagoInvoice: { companyId, tipo: "PAGO", status: "STAMPED" } },
      select: { parentUuid: true, impPagado: true },
    }),
  ]);

  const uuids = [...new Set(repLinks.map((l) => l.parentUuid))];
  const parents = uuids.length
    ? await prisma.invoice.findMany({
        where: { companyId, uuid: { in: uuids }, metodoPago: "PPD", status: "STAMPED" },
        select: {
          uuid: true,
          tipo: true,
          subtotal: true,
          total: true,
          taxes: { where: { tipo: "ISR", retencion: true }, select: { importe: true } },
        },
      })
    : [];
  const byUuid = new Map(parents.map((p) => [p.uuid!, p]));

  let ppdIngreso = 0;
  let ppdEgreso = 0;
  let ppdIsrRetenido = 0;
  for (const l of repLinks) {
    const p = byUuid.get(l.parentUuid);
    if (!p || p.total <= 0 || l.impPagado == null) continue;
    const fraccionPagada = l.impPagado / p.total;
    const base = l.impPagado * (p.subtotal / p.total); // subtotal-equivalent collected/paid
    if (p.tipo === "INGRESO") {
      ppdIngreso += base;
      const parentIsrRet = p.taxes.reduce((s, t) => s + t.importe, 0);
      ppdIsrRetenido += parentIsrRet * fraccionPagada; // retención del ingreso cobrado
    } else if (p.tipo === "EGRESO") {
      ppdEgreso += base;
    }
  }

  return {
    ingresosCobrados: (puIngreso._sum.subtotal ?? 0) + ppdIngreso,
    deduccionesPagadas: (puEgreso._sum.subtotal ?? 0) + ppdEgreso,
    isrRetenidoCobrado: (puIngresoIsrRet._sum.importe ?? 0) + ppdIsrRetenido,
  };
}

export interface TaxPosition {
  periodo: string;
  month: number;
  year: number;
  iva: {
    trasladado: number;
    retenidoPorClientes: number;
    acreditable: number;
    saldoFavorAnterior: number;
    /** Net IVA a pagar this period (>=0); excess becomes saldoAFavor. */
    pagar: number;
    saldoAFavor: number;
    devengado: { trasladado: number; acreditable: number };
  };
  isr: {
    /** Which régimen's method produced these figures. */
    metodo: IsrMetodo;
    ingresosDelMes: number;
    gastosDelMes: number;
    /** Acumulado ene→mes. Nominal/devengado for PM; cobrado for PF act. empresarial. */
    ingresosAcumulados: number;
    isrPagadoAnterior: number;
    coeficiente: number | null;
    coeficienteFuente: "manual" | "calculado" | "ninguno";
    /** How the auto coeficiente was derived (PM only); null for other régimenes. */
    coeficienteBase: { year: number; ingresos: number; utilidad: number; invoiceCount: number } | null;
    /** Base gravable: utilidad (×coef para PM, cobrado−deducciones para PF). */
    baseGravable: number | null;
    /** Tasa aplicada cuando es plana (PM 0.30, RESICO bracket); null si es tarifa progresiva. */
    tasa: number | null;
    /** Art. 14 derived figures; null when no coeficiente/tarifa is available. */
    utilidadFiscal: number | null;
    isrDelEjercicio: number | null;
    isrPagar: number | null;
    /** ISR retenido (Art. 106, 10% por PM) acreditado contra el provisional. 0 si no aplica al régimen. */
    retencionesAcreditadas: number;
    /** False when the tarifa used has NOT been verified vs the authoritative source. */
    tarifaVerificada: boolean;
  };
}

export type IsrMetodo = "PM_ART14" | "PF_ACT_EMPRESARIAL" | "RESICO_PF";

const ISR_TASA_PM = 0.3;

/**
 * Compute the monthly IVA + ISR position for a company from its CFDIs.
 * Pure of auth — callers must authorize access to `companyId` first.
 */
export async function computeTaxPosition(
  companyId: string,
  year: number,
  month: number,
  /** Optional upper bound for "precierre" (mid-month cutoff). Defaults to month end. */
  cutoff?: Date
): Promise<TaxPosition> {
  const from = new Date(year, month - 1, 1);
  const to = cutoff ?? new Date(year, month, 1);
  const yearFrom = new Date(year, 0, 1);
  const periodo = `${year}-${String(month).padStart(2, "0")}`;

  const prevYear = year - 1;
  const prevYearFrom = new Date(prevYear, 0, 1);
  const prevYearTo = new Date(prevYear, 11, 31, 23, 59, 59);
  const prevPeriodo =
    month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;

  const invoiceInclude = {
    taxes: true,
  } as const;

  const [
    facturasEmitidas,
    facturasEgresos,
    prevYearIngresos,
    prevYearEgresos,
    ingresosAcumuladosAgg,
    declaracionesPrevias,
    prevDeclaracion,
    company,
    repCobrosDelMes,
  ] = await Promise.all([
    prisma.invoice.findMany({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: from, lt: to } },
      include: invoiceInclude,
    }),
    prisma.invoice.findMany({
      where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: from, lt: to } },
      include: invoiceInclude,
    }),
    prisma.invoice.aggregate({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: prevYearFrom, lte: prevYearTo } },
      _sum: { subtotal: true },
      _count: { id: true },
    }),
    prisma.invoice.aggregate({
      where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: prevYearFrom, lte: prevYearTo } },
      _sum: { subtotal: true },
    }),
    prisma.invoice.aggregate({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: yearFrom, lt: to } },
      _sum: { subtotal: true },
    }),
    prisma.taxDeclaration.findMany({
      where: {
        companyId,
        // Both shapes: dedicated ISR_PROVISIONAL rows and legacy folded IVA_MENSUAL rows.
        tipo: { in: ["IVA_MENSUAL", "ISR_PROVISIONAL"] },
        periodo: { gte: `${year}-01`, lt: periodo },
        status: { in: ["CALCULATED", "FILED", "PAID"] },
      },
      select: { tipo: true, periodo: true, isrPagar: true },
    }),
    prisma.taxDeclaration.findFirst({
      where: {
        companyId,
        tipo: "IVA_MENSUAL",
        periodo: prevPeriodo,
        status: { in: ["CALCULATED", "FILED", "PAID"] },
      },
      select: { ivaSaldoFavor: true },
    }),
    prisma.company.findUnique({
      where: { id: companyId },
      select: { coeficienteUtilidad: true, coeficienteAnio: true, regimenFiscal: true, rfc: true },
    }),
    // PPD IVA is on a REP (complemento de pago) basis: every payment whose
    // FechaPago falls in this month, across all REPs of this company. Direction
    // (causado vs acreditable) is resolved from the parent invoice below.
    prisma.pagoDoctoRelacionado.findMany({
      where: {
        fechaPago: { gte: from, lt: to },
        pagoInvoice: { companyId, tipo: "PAGO", status: "STAMPED" },
      },
      select: { parentUuid: true, impPagado: true, ivaTrasladado: true, ivaDerivado: true },
    }),
  ]);

  // Resolve the parent PPD invoices these REP payments settle: the parent's
  // tipo decides direction (INGRESO → trasladado, EGRESO → acreditable) and its
  // IVA/total is the proration base for legacy 1.0 complementos.
  const repParentUuids = [...new Set(repCobrosDelMes.map((r) => r.parentUuid))];
  const repParents = repParentUuids.length
    ? await prisma.invoice.findMany({
        where: { companyId, uuid: { in: repParentUuids }, metodoPago: "PPD", status: "STAMPED" },
        select: { uuid: true, tipo: true, total: true, totalImpuestos: true, taxes: true },
      })
    : [];
  const repParentByUuid = new Map(repParents.map((p) => [p.uuid!, p]));

  let ivaTrasladadoPPD = 0;
  let ivaAcreditablePPD = 0;
  for (const link of repCobrosDelMes) {
    const parent = repParentByUuid.get(link.parentUuid);
    if (!parent) continue; // REP references a non-PPD or unknown invoice — skip
    const iva = repIvaTrasladado(link, parent);
    if (parent.tipo === "INGRESO") ivaTrasladadoPPD += iva;
    else if (parent.tipo === "EGRESO") ivaAcreditablePPD += iva;
  }

  // ── IVA (flujo de efectivo) ──────────────────────────────────────────────
  const ivaTrasladadoPUE = facturasEmitidas
    .filter((inv) => inv.metodoPago === "PUE")
    .reduce((s, inv) => s + ivaTrasladado(inv), 0);
  const ivaTrasladadoTotal = ivaTrasladadoPUE + ivaTrasladadoPPD;

  const ivaTrasladadoDevengado = facturasEmitidas.reduce((s, inv) => s + ivaTrasladado(inv), 0);
  const ivaRetenidoPorClientes = facturasEmitidas.reduce(
    (sum, inv) => sum + inv.taxes.filter((t) => t.tipo === "IVA" && t.retencion).reduce((s, t) => s + t.importe, 0),
    0
  );

  const ivaAcreditablePUE = facturasEgresos
    .filter((inv) => inv.metodoPago === "PUE")
    .reduce((s, inv) => s + ivaTrasladado(inv), 0);
  const ivaAcreditable = ivaAcreditablePUE + ivaAcreditablePPD;
  const ivaAcreditableDevengado = facturasEgresos.reduce((s, inv) => s + ivaTrasladado(inv), 0);

  const saldoFavorAnterior = prevDeclaracion?.ivaSaldoFavor ?? 0;
  const ivaNeto = ivaTrasladadoTotal - ivaAcreditable - ivaRetenidoPorClientes - saldoFavorAnterior;
  const ivaPagar = Math.max(0, round2(ivaNeto));
  const ivaSaldoAFavor = ivaNeto < 0 ? round2(-ivaNeto) : 0;

  // ── ISR provisional — régimen-aware ──────────────────────────────────────
  const ingresosDelMes = round2(facturasEmitidas.reduce((s, inv) => s + inv.subtotal, 0));
  const gastosDelMes = round2(facturasEgresos.reduce((s, inv) => s + inv.subtotal, 0));
  const ingresosAcumulados = ingresosAcumuladosAgg._sum.subtotal ?? 0;
  const isrPagadoAnterior = sumIsrPagar(declaracionesPrevias);

  const resicoKind = detectResicoKind(company?.regimenFiscal ?? null, company?.rfc ?? null);
  const esPfActEmpresarial =
    company?.regimenFiscal === "612" && (company?.rfc?.trim().length ?? 0) === 13;

  let isr: TaxPosition["isr"];

  if (resicoKind === "pf") {
    // RESICO PF (Art. 113-E): tarifa mensual sobre ingresos del mes (cobrado
    // approximado por ingresos stamped del mes — igual que el cálculo actual).
    const res = calcularIsrResicoPf(ingresosDelMes);
    isr = {
      metodo: "RESICO_PF",
      ingresosDelMes,
      gastosDelMes,
      ingresosAcumulados: round2(ingresosAcumulados),
      isrPagadoAnterior: round2(isrPagadoAnterior),
      coeficiente: null,
      coeficienteFuente: "ninguno",
      coeficienteBase: null,
      baseGravable: res.ingresos,
      tasa: res.tasa,
      utilidadFiscal: null,
      isrDelEjercicio: res.isr, // mensual definitivo (no acumulado)
      isrPagar: res.isr,
      retencionesAcreditadas: 0, // RESICO PF (1.25% PM) — fuera de alcance de #20
      tarifaVerificada: true,
    };
  } else if (esPfActEmpresarial) {
    // PF con actividad empresarial (Art. 106): base en FLUJO DE EFECTIVO
    // (ingresos cobrados − deducciones pagadas, acumulado) × tarifa Art. 96.
    const { ingresosCobrados, deduccionesPagadas, isrRetenidoCobrado } = await flujoEfectivoAcum(companyId, yearFrom, to);
    const r = calcularIsrProvisionalPf({
      ejercicio: year,
      meses: month,
      ingresosCobradosAcum: ingresosCobrados,
      deduccionesPagadasAcum: deduccionesPagadas,
      pagosProvisionalesAnteriores: isrPagadoAnterior,
      // ISR 10% retenido por personas morales (Art. 106), acreditado en flujo:
      // sólo la retención de ingresos efectivamente cobrados (ene→mes).
      retencionesAcum: isrRetenidoCobrado,
    });
    isr = {
      metodo: "PF_ACT_EMPRESARIAL",
      ingresosDelMes,
      gastosDelMes,
      ingresosAcumulados: round2(ingresosCobrados), // cash basis cumulative
      isrPagadoAnterior: round2(isrPagadoAnterior),
      coeficiente: null,
      coeficienteFuente: "ninguno",
      coeficienteBase: null,
      baseGravable: r ? r.baseGravable : null,
      tasa: null, // tarifa progresiva
      utilidadFiscal: r ? r.baseGravable : null,
      isrDelEjercicio: r ? r.isrCausado : null,
      isrPagar: r ? r.isrPagar : null,
      retencionesAcreditadas: r ? r.retencionesAcum : 0,
      tarifaVerificada: r ? r.tarifaVerificada : false,
    };
  } else {
    // Persona moral general / RESICO PM / otros: Art. 14 (coeficiente × 30%
    // sobre ingresos nominales acumulados).
    const prevIngresosTotal = prevYearIngresos._sum.subtotal ?? 0;
    const prevGastosTotal = prevYearEgresos._sum.subtotal ?? 0;
    const prevUtilidad = Math.max(0, prevIngresosTotal - prevGastosTotal);
    const coeficienteCalculado = prevIngresosTotal > 0 ? prevUtilidad / prevIngresosTotal : null;

    let coeficiente: number | null;
    let coeficienteFuente: "manual" | "calculado" | "ninguno";
    if (company?.coeficienteUtilidad != null && (company.coeficienteAnio === year || company.coeficienteAnio == null)) {
      coeficiente = company.coeficienteUtilidad;
      coeficienteFuente = "manual";
    } else if (coeficienteCalculado !== null) {
      coeficiente = coeficienteCalculado;
      coeficienteFuente = "calculado";
    } else {
      coeficiente = null;
      coeficienteFuente = "ninguno";
    }

    let utilidadFiscal: number | null = null;
    let isrDelEjercicio: number | null = null;
    let isrPagar: number | null = null;
    if (coeficiente !== null && coeficiente > 0) {
      utilidadFiscal = round2(ingresosAcumulados * coeficiente);
      isrDelEjercicio = round2(utilidadFiscal * ISR_TASA_PM);
      isrPagar = Math.max(0, round2(isrDelEjercicio - isrPagadoAnterior));
    }

    isr = {
      metodo: "PM_ART14",
      ingresosDelMes,
      gastosDelMes,
      ingresosAcumulados: round2(ingresosAcumulados),
      isrPagadoAnterior: round2(isrPagadoAnterior),
      coeficiente,
      coeficienteFuente,
      coeficienteBase:
        coeficienteFuente === "calculado"
          ? {
              year: prevYear,
              ingresos: round2(prevIngresosTotal),
              utilidad: round2(prevUtilidad),
              invoiceCount: prevYearIngresos._count.id,
            }
          : null,
      baseGravable: utilidadFiscal,
      tasa: ISR_TASA_PM,
      utilidadFiscal,
      isrDelEjercicio,
      isrPagar,
      retencionesAcreditadas: 0, // PM Art. 14 no acredita retención 10% PF
      tarifaVerificada: true,
    };
  }

  return {
    periodo,
    month,
    year,
    iva: {
      trasladado: round2(ivaTrasladadoTotal),
      retenidoPorClientes: round2(ivaRetenidoPorClientes),
      acreditable: round2(ivaAcreditable),
      saldoFavorAnterior: round2(saldoFavorAnterior),
      pagar: ivaPagar,
      saldoAFavor: ivaSaldoAFavor,
      devengado: {
        trasladado: round2(ivaTrasladadoDevengado),
        acreditable: round2(ivaAcreditableDevengado),
      },
    },
    isr,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
