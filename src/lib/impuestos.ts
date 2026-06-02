import { prisma } from "./prisma";
import { sumIsrPagar } from "./isr-provisional";

// ─────────────────────────────────────────────────────────────────────────────
// Monthly tax position (IVA + ISR provisional) computed from synced CFDIs.
//
// Extracted from the /api/impuestos route so the same logic powers the web
// page, the AI/WhatsApp tools, and the dashboard — one source of truth.
//
// IVA is on FLUJO DE EFECTIVO (cash basis, Art. 1-B LIVA):
//   - PUE: causa el mes de emisión (se asume pagada)
//   - PPD: causa el mes en que se cobra/paga (bank tx match), proporcional a lo pagado
// ISR provisional uses the Art. 14 cumulative formula with the coeficiente de
// utilidad (manual override → prior-year calculated → none).
// ─────────────────────────────────────────────────────────────────────────────

type InvoiceLike = {
  taxes: { tipo: string; retencion: boolean; importe: number }[];
  totalImpuestos: number | null;
};
type InvoiceWithBank = InvoiceLike & { total: number; bankTransactions: { monto: number }[] };

function ivaTrasladado(inv: InvoiceLike): number {
  const ivaTaxes = inv.taxes.filter((t) => t.tipo === "IVA" && !t.retencion);
  return ivaTaxes.length > 0
    ? ivaTaxes.reduce((s, t) => s + t.importe, 0)
    : (inv.totalImpuestos ?? 0);
}

function paidFractionThisMonth(inv: InvoiceWithBank): number {
  if (!inv.bankTransactions.length) return 0;
  const paid = inv.bankTransactions.reduce((s, t) => s + Math.abs(t.monto), 0);
  return inv.total > 0 ? Math.min(1, paid / inv.total) : 0;
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
    ingresosDelMes: number;
    gastosDelMes: number;
    ingresosAcumulados: number;
    isrPagadoAnterior: number;
    coeficiente: number | null;
    coeficienteFuente: "manual" | "calculado" | "ninguno";
    /** Art. 14 derived figures; null when no coeficiente is available. */
    utilidadFiscal: number | null;
    isrDelEjercicio: number | null;
    isrPagar: number | null;
  };
}

const ISR_TASA_PM = 0.3;

/**
 * Compute the monthly IVA + ISR position for a company from its CFDIs.
 * Pure of auth — callers must authorize access to `companyId` first.
 */
export async function computeTaxPosition(
  companyId: string,
  year: number,
  month: number
): Promise<TaxPosition> {
  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month, 1);
  const yearFrom = new Date(year, 0, 1);
  const periodo = `${year}-${String(month).padStart(2, "0")}`;

  const prevYear = year - 1;
  const prevYearFrom = new Date(prevYear, 0, 1);
  const prevYearTo = new Date(prevYear, 11, 31, 23, 59, 59);
  const prevPeriodo =
    month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;

  const invoiceInclude = {
    taxes: true,
    bankTransactions: { select: { monto: true, status: true, fecha: true } },
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
    ppdIngresosCobrados,
    ppdEgresosPagados,
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
      select: { coeficienteUtilidad: true, coeficienteAnio: true },
    }),
    prisma.invoice.findMany({
      where: {
        companyId, status: "STAMPED", tipo: "INGRESO", metodoPago: "PPD",
        fecha: { lt: from },
        bankTransactions: { some: { status: "MATCHED", fecha: { gte: from, lt: to } } },
      },
      include: {
        taxes: true,
        bankTransactions: { where: { status: "MATCHED", fecha: { gte: from, lt: to } }, select: { monto: true } },
      },
    }),
    prisma.invoice.findMany({
      where: {
        companyId, status: "STAMPED", tipo: "EGRESO", metodoPago: "PPD",
        fecha: { lt: from },
        bankTransactions: { some: { status: "MATCHED", fecha: { gte: from, lt: to } } },
      },
      include: {
        taxes: true,
        bankTransactions: { where: { status: "MATCHED", fecha: { gte: from, lt: to } }, select: { monto: true } },
      },
    }),
  ]);

  // ── IVA (flujo de efectivo) ──────────────────────────────────────────────
  const ivaTrasladadoPUE = facturasEmitidas
    .filter((inv) => inv.metodoPago === "PUE")
    .reduce((s, inv) => s + ivaTrasladado(inv), 0);
  const ivaTrasladadoPPDMes = facturasEmitidas
    .filter((inv) => inv.metodoPago === "PPD")
    .reduce((s, inv) => s + ivaTrasladado(inv) * paidFractionThisMonth(inv as InvoiceWithBank), 0);
  const ivaTrasladadoPPDPrev = ppdIngresosCobrados
    .reduce((s, inv) => s + ivaTrasladado(inv) * paidFractionThisMonth(inv as InvoiceWithBank), 0);
  const ivaTrasladadoTotal = ivaTrasladadoPUE + ivaTrasladadoPPDMes + ivaTrasladadoPPDPrev;

  const ivaTrasladadoDevengado = facturasEmitidas.reduce((s, inv) => s + ivaTrasladado(inv), 0);
  const ivaRetenidoPorClientes = facturasEmitidas.reduce(
    (sum, inv) => sum + inv.taxes.filter((t) => t.tipo === "IVA" && t.retencion).reduce((s, t) => s + t.importe, 0),
    0
  );

  const ivaAcreditablePUE = facturasEgresos
    .filter((inv) => inv.metodoPago === "PUE")
    .reduce((s, inv) => s + ivaTrasladado(inv), 0);
  const ivaAcreditablePPDMes = facturasEgresos
    .filter((inv) => inv.metodoPago === "PPD")
    .reduce((s, inv) => s + ivaTrasladado(inv) * paidFractionThisMonth(inv as InvoiceWithBank), 0);
  const ivaAcreditablePPDPrev = ppdEgresosPagados
    .reduce((s, inv) => s + ivaTrasladado(inv) * paidFractionThisMonth(inv as InvoiceWithBank), 0);
  const ivaAcreditable = ivaAcreditablePUE + ivaAcreditablePPDMes + ivaAcreditablePPDPrev;
  const ivaAcreditableDevengado = facturasEgresos.reduce((s, inv) => s + ivaTrasladado(inv), 0);

  const saldoFavorAnterior = prevDeclaracion?.ivaSaldoFavor ?? 0;
  const ivaNeto = ivaTrasladadoTotal - ivaAcreditable - ivaRetenidoPorClientes - saldoFavorAnterior;
  const ivaPagar = Math.max(0, round2(ivaNeto));
  const ivaSaldoAFavor = ivaNeto < 0 ? round2(-ivaNeto) : 0;

  // ── ISR provisional (Art. 14) ────────────────────────────────────────────
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

  const ingresosAcumulados = ingresosAcumuladosAgg._sum.subtotal ?? 0;
  const isrPagadoAnterior = sumIsrPagar(declaracionesPrevias);

  let utilidadFiscal: number | null = null;
  let isrDelEjercicio: number | null = null;
  let isrPagar: number | null = null;
  if (coeficiente !== null && coeficiente > 0) {
    utilidadFiscal = round2(ingresosAcumulados * coeficiente);
    isrDelEjercicio = round2(utilidadFiscal * ISR_TASA_PM);
    isrPagar = Math.max(0, round2(isrDelEjercicio - isrPagadoAnterior));
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
    isr: {
      ingresosDelMes: round2(facturasEmitidas.reduce((s, inv) => s + inv.subtotal, 0)),
      gastosDelMes: round2(facturasEgresos.reduce((s, inv) => s + inv.subtotal, 0)),
      ingresosAcumulados: round2(ingresosAcumulados),
      isrPagadoAnterior: round2(isrPagadoAnterior),
      coeficiente,
      coeficienteFuente,
      utilidadFiscal,
      isrDelEjercicio,
      isrPagar,
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
