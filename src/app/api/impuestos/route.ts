import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { sumIsrPagar } from "@/lib/isr-provisional";
import type { TaxDeclarationType } from "@prisma/client";

// GET /api/impuestos?companyId=xxx&month=4&year=2026
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const month = parseInt(searchParams.get("month") ?? "");
  const year = parseInt(searchParams.get("year") ?? "");

  if (!companyId || isNaN(month) || isNaN(year)) {
    return NextResponse.json({ error: "companyId, month y year son requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  // ── Period boundaries ─────────────────────────────────────────────────────
  // When `cutoffDate` is passed (YYYY-MM-DD), we clamp the upper bound to
  // that date + 1 day. This is how contadores do a "precierre": run the
  // monthly numbers against partial data (e.g. through mid-month) to plan
  // ahead before the fiscal deadline.
  const cutoffStr = searchParams.get("cutoffDate");
  const from = new Date(year, month - 1, 1);
  const defaultTo = new Date(year, month, 1);
  let to = defaultTo;
  if (cutoffStr) {
    // cutoffStr is "YYYY-MM-DD" in the user's local calendar. Interpret
    // inclusively: everything up to end-of-that-day.
    const parsed = new Date(`${cutoffStr}T23:59:59.999`);
    if (!isNaN(parsed.getTime()) && parsed >= from && parsed <= defaultTo) {
      to = parsed;
    }
  }
  const isPreliminar = to.getTime() !== defaultTo.getTime();
  const yearFrom = new Date(year, 0, 1);       // Jan 1 of this year
  const periodo  = `${year}-${String(month).padStart(2, "0")}`;

  // ── Parallel data fetch ───────────────────────────────────────────────────
  const prevYear     = year - 1;
  const prevYearFrom = new Date(prevYear, 0, 1);
  const prevYearTo   = new Date(prevYear, 11, 31, 23, 59, 59);

  const prevPeriodo = month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, "0")}`;

  const [
    facturasEmitidas,
    facturasEgresos,
    prevYearIngresos,
    prevYearEgresos,
    ingresosAcumuladosAgg,
    declaracionesPrevias,
    prevDeclaracion,
    declaracionGuardada,
    company,
    ppdIngresosCobrados,
    ppdEgresosPagados,
    nominaThisMonth,
    nominaPrevMonths,
  ] = await Promise.all([
    // This month's invoices (includes metodoPago for flujo de efectivo)
    prisma.invoice.findMany({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: from, lt: to } },
      include: {
        customer: { select: { razonSocial: true, rfc: true } },
        taxes: true,
        bankTransactions: { select: { id: true, fecha: true, monto: true, status: true } },
      },
      orderBy: { fecha: "asc" },
    }),
    prisma.invoice.findMany({
      where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: from, lt: to } },
      include: {
        customer: { select: { razonSocial: true, rfc: true } },
        taxes: true,
        bankTransactions: { select: { id: true, fecha: true, monto: true, status: true } },
      },
      orderBy: { fecha: "asc" },
    }),
    // Previous year totals — for coeficiente calculation
    prisma.invoice.aggregate({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: prevYearFrom, lte: prevYearTo } },
      _sum: { subtotal: true },
      _count: { id: true },
    }),
    prisma.invoice.aggregate({
      where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: prevYearFrom, lte: prevYearTo } },
      _sum: { subtotal: true },
    }),
    // Cumulative ingresos Jan → end of current month (for ISR acumulado)
    prisma.invoice.aggregate({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: yearFrom, lt: to } },
      _sum: { subtotal: true },
    }),
    // Saved declarations Jan → month-1 of this year (for ISR ya pagado). Includes
    // both the dedicated ISR_PROVISIONAL rows AND legacy folded IVA_MENSUAL rows;
    // sumIsrPagar dedupes per periodo so imported history is counted exactly once.
    prisma.taxDeclaration.findMany({
      where: {
        companyId,
        tipo: { in: ["IVA_MENSUAL", "ISR_PROVISIONAL"] },
        periodo: { gte: `${year}-01`, lt: periodo },
        status: { in: ["CALCULATED", "FILED", "PAID"] },
      },
      select: { tipo: true, periodo: true, isrPagar: true },
    }),
    // Previous month's declaration — for IVA saldo a favor carryover
    prisma.taxDeclaration.findFirst({
      where: {
        companyId,
        tipo: "IVA_MENSUAL",
        periodo: prevPeriodo,
        status: { in: ["CALCULATED", "FILED", "PAID"] },
      },
    }),
    // This month's existing declaration (to restore overrides)
    prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: "IVA_MENSUAL", periodo },
      select: {
        id: true, status: true, isHistorical: true,
        ivaSaldoFavorAnterior: true, isrCoeficienteUtilidad: true,
        ivaSaldoFavor: true, ivaTrasladadoCobrado: true, ivaAcreditableGastado: true,
        ivaPagar: true, isrIngresos: true, isrDeducciones: true,
        isrBaseGravable: true, isrTasa: true, isrPagar: true,
        acuseUrl: true, lineaCaptura: true, fechaPresentacion: true, fechaLimitePago: true,
      },
    }),
    // Company — coeficiente override
    prisma.company.findUnique({
      where: { id: companyId },
      select: { coeficienteUtilidad: true, coeficienteAnio: true },
    }),
    // PPD INGRESOS from PRIOR months with bank payments matched THIS month
    // (IVA causa cobrado this month per flujo de efectivo — Art. 1-B LIVA)
    prisma.invoice.findMany({
      where: {
        companyId, status: "STAMPED", tipo: "INGRESO", metodoPago: "PPD",
        fecha: { lt: from },
        bankTransactions: { some: { status: "MATCHED", fecha: { gte: from, lt: to } } },
      },
      include: {
        taxes: true,
        bankTransactions: {
          where: { status: "MATCHED", fecha: { gte: from, lt: to } },
          select: { monto: true },
        },
      },
    }),
    // PPD EGRESOS from PRIOR months paid THIS month (IVA acreditable pagado)
    prisma.invoice.findMany({
      where: {
        companyId, status: "STAMPED", tipo: "EGRESO", metodoPago: "PPD",
        fecha: { lt: from },
        bankTransactions: { some: { status: "MATCHED", fecha: { gte: from, lt: to } } },
      },
      include: {
        taxes: true,
        bankTransactions: {
          where: { status: "MATCHED", fecha: { gte: from, lt: to } },
          select: { monto: true },
        },
      },
    }),
    // Nómina ISR retenciones this month (from PayrollItems)
    prisma.payrollItem.aggregate({
      where: {
        payrollRun: {
          companyId,
          status: { in: ["CALCULATED", "STAMPED", "PAID"] },
          fechaPago: { gte: from, lt: to },
        },
      },
      _sum: { isrRetenido: true, imssObrero: true, imssPatronal: true, infonavit: true, totalPercepciones: true },
    }),
    // Nómina ISR retenciones Jan → prev month (cumulative for ISR ya pagado)
    prisma.payrollItem.aggregate({
      where: {
        payrollRun: {
          companyId,
          status: { in: ["CALCULATED", "STAMPED", "PAID"] },
          fechaPago: { gte: yearFrom, lt: from },
        },
      },
      _sum: { isrRetenido: true },
    }),
  ]);

  // Saved retenciones (nómina) enteramiento for this period — its own RETENCIONES_ISR
  // row, separate from the IVA/ISR declaration. Lets the UI reflect filing status.
  const retencionesGuardada = await prisma.taxDeclaration.findFirst({
    where: { companyId, tipo: "RETENCIONES_ISR", periodo },
    select: {
      id: true, status: true, retencionesIsr: true,
      acuseUrl: true, lineaCaptura: true, fechaPresentacion: true, fechaLimitePago: true,
    },
  });

  // This period's dedicated ISR provisional row (source of truth for ISR figures
  // and the coeficiente override). Legacy periods may still carry these on the
  // IVA_MENSUAL row instead — declaracionGuardada below falls back to it.
  const isrProvGuardada = await prisma.taxDeclaration.findFirst({
    where: { companyId, tipo: "ISR_PROVISIONAL", periodo },
    select: { id: true, status: true, isrPagar: true, isrCoeficienteUtilidad: true },
  });

  // ── IVA calculations ──────────────────────────────────────────────────────
  // IVA works on FLUJO DE EFECTIVO (cash basis, Art. 1-B LIVA):
  // - PUE: IVA causa el mes de emisión (se asume pagada)
  // - PPD: IVA causa el mes en que se recibe el pago (bank tx match)
  //
  // For acreditable the same rule applies: PUE = mes de factura,
  // PPD = mes en que se paga al proveedor.

  // Helper to extract IVA trasladado (excludes retenciones) from an invoice
  type InvoiceLike = { taxes: { tipo: string; retencion: boolean; importe: number }[]; totalImpuestos: number | null };
  function ivaTrasladado(inv: InvoiceLike): number {
    const ivaTaxes = inv.taxes.filter((t) => t.tipo === "IVA" && !t.retencion);
    return ivaTaxes.length > 0
      ? ivaTaxes.reduce((s, t) => s + t.importe, 0)
      : (inv.totalImpuestos ?? 0);
  }

  // Helper: compute what fraction of an invoice has been paid this month
  // (proportional IVA for partial payments on PPDs)
  type InvoiceWithBank = InvoiceLike & { total: number; bankTransactions: { monto: number }[] };
  function paidFractionThisMonth(inv: InvoiceWithBank): number {
    if (!inv.bankTransactions.length) return 0;
    const paid = inv.bankTransactions.reduce((s, t) => s + Math.abs(t.monto), 0);
    return inv.total > 0 ? Math.min(1, paid / inv.total) : 0;
  }

  // IVA trasladado cobrado (flujo de efectivo):
  // - PUE del mes: IVA completo
  // - PPD del mes con pago matched en el mes: IVA completo si full-paid, proporcional si partial
  // - PPD de meses anteriores con pago recibido este mes: IVA proporcional
  const ivaTrasladadoPUE = facturasEmitidas
    .filter(inv => inv.metodoPago === "PUE")
    .reduce((s, inv) => s + ivaTrasladado(inv), 0);

  const ivaTrasladadoPPDMes = facturasEmitidas
    .filter(inv => inv.metodoPago === "PPD")
    .reduce((s, inv) => s + ivaTrasladado(inv) * paidFractionThisMonth(inv as InvoiceWithBank), 0);

  const ivaTrasladadoPPDPrev = ppdIngresosCobrados
    .reduce((s, inv) => s + ivaTrasladado(inv) * paidFractionThisMonth(inv as InvoiceWithBank), 0);

  const ivaTrasladadoTotal = ivaTrasladadoPUE + ivaTrasladadoPPDMes + ivaTrasladadoPPDPrev;

  // IVA devengado (all stamped CFDIs regardless of payment) — informational
  const ivaTrasladadoDevengado = facturasEmitidas.reduce((s, inv) => s + ivaTrasladado(inv), 0);

  const ivaRetenidoPorClientes = facturasEmitidas.reduce((sum, inv) =>
    sum + inv.taxes.filter((t) => t.tipo === "IVA" && t.retencion).reduce((s, t) => s + t.importe, 0), 0);

  // IVA acreditable pagado (same logic as trasladado but for egresos)
  const ivaAcreditablePUE = facturasEgresos
    .filter(inv => inv.metodoPago === "PUE")
    .reduce((s, inv) => s + ivaTrasladado(inv), 0);

  const ivaAcreditablePPDMes = facturasEgresos
    .filter(inv => inv.metodoPago === "PPD")
    .reduce((s, inv) => s + ivaTrasladado(inv) * paidFractionThisMonth(inv as InvoiceWithBank), 0);

  const ivaAcreditablePPDPrev = ppdEgresosPagados
    .reduce((s, inv) => s + ivaTrasladado(inv) * paidFractionThisMonth(inv as InvoiceWithBank), 0);

  const ivaAcreditable = ivaAcreditablePUE + ivaAcreditablePPDMes + ivaAcreditablePPDPrev;

  const ivaAcreditableDevengado = facturasEgresos.reduce((s, inv) => s + ivaTrasladado(inv), 0);

  // Pending IVA (emitted but not yet collected) — useful for planning
  const ivaPendienteCobrar = ivaTrasladadoDevengado - ivaTrasladadoPUE - ivaTrasladadoPPDMes;
  const ivaPendientePagar = ivaAcreditableDevengado - ivaAcreditablePUE - ivaAcreditablePPDMes;

  // Auto saldo a favor from previous month's declaration
  const saldoFavorAnteriorAuto = prevDeclaracion?.ivaSaldoFavor ?? 0;

  // ── ISR — coeficiente de utilidad ─────────────────────────────────────────
  const prevIngresosTotal  = prevYearIngresos._sum.subtotal ?? 0;
  const prevGastosTotal    = prevYearEgresos._sum.subtotal ?? 0;
  const prevUtilidad       = Math.max(0, prevIngresosTotal - prevGastosTotal);
  const invoiceCountPrevYear = prevYearIngresos._count.id;

  const coeficienteCalculado = prevIngresosTotal > 0
    ? prevUtilidad / prevIngresosTotal
    : null;

  // Priority: (1) Company override for this year, (2) auto-calculated, (3) null
  let coeficiente: number | null;
  let coeficienteFuente: "manual" | "calculado" | "ninguno";

  if (company?.coeficienteUtilidad != null && (company.coeficienteAnio === year || company.coeficienteAnio == null)) {
    // Use stored CU: either it's explicitly for this year, or it was imported
    // without a year (legacy) and we use it as the best available
    coeficiente      = company.coeficienteUtilidad;
    coeficienteFuente = "manual";
  } else if (coeficienteCalculado !== null) {
    coeficiente      = coeficienteCalculado;
    coeficienteFuente = "calculado";
  } else {
    coeficiente      = null;
    coeficienteFuente = "ninguno";
  }

  // ── ISR cumulative figures ────────────────────────────────────────────────
  const ingresosAcumulados = ingresosAcumuladosAgg._sum.subtotal ?? 0;
  const isrPagadoAnterior  = sumIsrPagar(declaracionesPrevias);

  // ── Nómina retenciones ──────────────────────────────────────────────────
  const nominaIsrMes       = nominaThisMonth._sum.isrRetenido ?? 0;
  const nominaImssMes      = nominaThisMonth._sum.imssObrero ?? 0;
  const nominaImssPatronal = nominaThisMonth._sum.imssPatronal ?? 0;
  const nominaInfonavitMes = nominaThisMonth._sum.infonavit ?? 0;
  const nominaPercepMes    = nominaThisMonth._sum.totalPercepciones ?? 0;
  const nominaIsrAcum      = nominaPrevMonths._sum.isrRetenido ?? 0; // Jan → prev month

  // Raw month figures (for the invoices table)
  const ingresosDelMes = facturasEmitidas.reduce((s, inv) => s + inv.subtotal, 0);
  const gastosDelMes   = facturasEgresos.reduce((s, inv) => s + inv.subtotal, 0);

  // ── Build unified facturas list ───────────────────────────────────────────
  type InvoiceWithRelations = typeof facturasEmitidas[number];
  const toRow = (inv: InvoiceWithRelations, tipo: "INGRESO" | "EGRESO") => ({
    id: inv.id,
    uuid: inv.uuid,
    tipo,
    fecha: inv.fecha,
    contraparte: inv.customer?.razonSocial ?? "—",
    rfc: inv.customer?.rfc ?? "—",
    subtotal: inv.subtotal,
    iva: inv.totalImpuestos ?? 0,
    total: inv.total,
  });

  const facturas = [
    ...facturasEmitidas.map((inv) => toRow(inv, "INGRESO")),
    ...facturasEgresos.map((inv) => toRow(inv, "EGRESO")),
  ].sort((a, b) => new Date(a.fecha).getTime() - new Date(b.fecha).getTime());

  return NextResponse.json({
    periodo,
    month,
    year,
    cutoffDate: isPreliminar ? cutoffStr : null,
    isPreliminar,
    iva: {
      // Flujo de efectivo (what SAT actually expects)
      trasladado: ivaTrasladadoTotal,
      retenidoPorClientes: ivaRetenidoPorClientes,
      acreditable: ivaAcreditable,
      saldoFavorAnterior: saldoFavorAnteriorAuto,
      saldoFavorAnteriorPeriodo: saldoFavorAnteriorAuto > 0 ? prevPeriodo : null,
      // Desglose flujo de efectivo
      desglose: {
        trasladadoPUE: ivaTrasladadoPUE,
        trasladadoPPDCobradoEsteMes: ivaTrasladadoPPDMes,
        trasladadoPPDCobradoMesesAnteriores: ivaTrasladadoPPDPrev,
        acreditablePUE: ivaAcreditablePUE,
        acreditablePPDPagadoEsteMes: ivaAcreditablePPDMes,
        acreditablePPDPagadoMesesAnteriores: ivaAcreditablePPDPrev,
      },
      // Devengado (informational — NOT what SAT expects, but useful for comparison)
      devengado: {
        trasladado: ivaTrasladadoDevengado,
        acreditable: ivaAcreditableDevengado,
      },
      // Pendiente (invoices emitted but not yet paid — "IVA atrapado")
      pendiente: {
        porCobrar: ivaPendienteCobrar,
        porPagar: ivaPendientePagar,
      },
    },
    nomina: {
      isrRetenidoMes: nominaIsrMes,
      imssObreroMes: nominaImssMes,
      imssPatronalMes: nominaImssPatronal,
      infonavitMes: nominaInfonavitMes,
      percepcionesMes: nominaPercepMes,
      isrRetenidoAcumulado: nominaIsrAcum + nominaIsrMes,
      // ISR retenido a enterar este mes (Art. 96 LISR — impuesto del trabajador,
      // enteramiento aparte; NO acredita contra el ISR provisional propio).
      isrRetencionesAEnterar: nominaIsrMes,
      // Estado del enteramiento guardado (su propio renglón RETENCIONES_ISR)
      enteramiento: retencionesGuardada
        ? {
            id: retencionesGuardada.id,
            status: retencionesGuardada.status,
            montoEnterado: retencionesGuardada.retencionesIsr,
            acuseUrl: retencionesGuardada.acuseUrl,
            lineaCaptura: retencionesGuardada.lineaCaptura,
            fechaPresentacion: retencionesGuardada.fechaPresentacion,
            fechaLimitePago: retencionesGuardada.fechaLimitePago,
          }
        : null,
    },
    isr: {
      ingresosDelMes,
      gastosDelMes,
      ingresosAcumulados,        // Jan → this month (for Art. 14 formula)
      isrPagadoAnterior,         // ISR already paid Jan → prev month
      coeficiente,               // null if no data at all
      coeficienteFuente,
      // Details shown to user explaining how it was calculated
      coeficienteBase: coeficienteFuente === "calculado" ? {
        year: prevYear,
        ingresos: prevIngresosTotal,
        utilidad: prevUtilidad,
        invoiceCount: invoiceCountPrevYear,
      } : null,
    },
    facturas,
    declaracionGuardada: declaracionGuardada ? {
      id: declaracionGuardada.id,
      status: declaracionGuardada.status,
      isHistorical: declaracionGuardada.isHistorical ?? false,
      // Restore any manual overrides the user saved last time. The coeficiente
      // now lives on the dedicated ISR_PROVISIONAL row; fall back to the legacy
      // folded value on the IVA_MENSUAL row for periods saved before the split.
      saldoFavorAnteriorOverride: declaracionGuardada.ivaSaldoFavorAnterior,
      coeficienteOverride: isrProvGuardada?.isrCoeficienteUtilidad ?? declaracionGuardada.isrCoeficienteUtilidad,
      // Acuse fields
      acuseUrl: declaracionGuardada.acuseUrl,
      lineaCaptura: declaracionGuardada.lineaCaptura,
      fechaPresentacion: declaracionGuardada.fechaPresentacion,
      fechaLimitePago: declaracionGuardada.fechaLimitePago,
    } : null,
  });
}

// POST /api/impuestos — save/update declaration
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const {
    companyId, periodo, tipo,
    ivaData, isrData, retencionesData, status,
    saldoFavorAnterior,
    coeficienteUtilidad,
    year,
    // Acuse de recibo fields
    acuseUrl, lineaCaptura, fechaPresentacion, fechaLimitePago,
  } = body;

  if (!companyId || !periodo || !tipo) {
    return NextResponse.json({ error: "Datos incompletos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  // Acuse/presentación patch shared by every row of the period. Each field is
  // included only when the caller actually sent it, so a partial save (e.g.
  // acuse-only) never wipes previously-saved figures.
  const acusePatch = {
    ...(status !== undefined && { status: status ?? "CALCULATED" }),
    ...(acuseUrl !== undefined && { acuseUrl: acuseUrl ?? null }),
    ...(lineaCaptura !== undefined && { lineaCaptura: lineaCaptura ?? null }),
    ...(fechaPresentacion !== undefined && {
      fechaPresentacion: fechaPresentacion ? new Date(fechaPresentacion) : null,
    }),
    ...(fechaLimitePago !== undefined && {
      fechaLimitePago: fechaLimitePago ? new Date(fechaLimitePago) : null,
    }),
  };

  // Upsert a single declaration row by (companyId, tipo, periodo), applying only
  // the provided fields.
  async function upsertRow(rowTipo: TaxDeclarationType, patch: Record<string, unknown>) {
    const existing = await prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: rowTipo, periodo },
      select: { id: true },
    });
    return existing
      ? prisma.taxDeclaration.update({ where: { id: existing.id }, data: patch })
      : prisma.taxDeclaration.create({
          data: { companyId, tipo: rowTipo, periodo, status: "CALCULATED", ...patch },
        });
  }

  const isrFields = (d: NonNullable<typeof isrData>) => ({
    isrIngresos:    d.ingresosAcumulados ?? null,
    isrDeducciones: d.gastosDelMes       ?? null,
    isrBaseGravable: d.utilidadFiscal    ?? null,
    isrTasa:        0.30,
    isrPagar:       d.esteMes            ?? null,
    ...(typeof coeficienteUtilidad === "number" && { isrCoeficienteUtilidad: coeficienteUtilidad }),
  });

  let primary;

  if (tipo === "IVA_MENSUAL") {
    // IVA figures stay on the IVA_MENSUAL row; ISR provisional figures move to
    // their own ISR_PROVISIONAL row (Art. 14 — a distinct obligation). When IVA
    // data is sent we also clear any legacy folded ISR on this row so periods
    // saved before the split migrate cleanly on re-save.
    primary = await upsertRow("IVA_MENSUAL", {
      ...acusePatch,
      ...(typeof saldoFavorAnterior === "number" && { ivaSaldoFavorAnterior: saldoFavorAnterior }),
      ...(ivaData && {
        ivaTrasladadoCobrado:  ivaData.trasladado  ?? null,
        ivaAcreditableGastado: ivaData.acreditable ?? null,
        ivaSaldoFavor:         ivaData.saldoFavor  ?? null,
        ivaPagar:              ivaData.pagar        ?? null,
        isrIngresos: null, isrDeducciones: null, isrBaseGravable: null,
        isrTasa: null, isrPagar: null, isrCoeficienteUtilidad: null,
      }),
    });

    if (isrData) {
      await upsertRow("ISR_PROVISIONAL", { ...acusePatch, ...isrFields(isrData) });
    } else if (Object.keys(acusePatch).length > 0) {
      // Acuse-/status-only save: IVA and ISR provisional are filed in one
      // presentation, so mirror the acuse onto an existing ISR_PROVISIONAL row.
      // Don't create one from acuse alone — there are no ISR figures to back it.
      await prisma.taxDeclaration.updateMany({
        where: { companyId, tipo: "ISR_PROVISIONAL", periodo },
        data: acusePatch,
      });
    }
  } else if (tipo === "RETENCIONES_ISR") {
    // ISR retenido a enterar (nómina) — its own row, separate from ISR provisional.
    primary = await upsertRow("RETENCIONES_ISR", {
      ...acusePatch,
      ...(retencionesData && { retencionesIsr: retencionesData.aEnterar ?? null }),
    });
  } else {
    // Generic single-row save (ISR_PROVISIONAL direct, DECLARACION_ANUAL, etc.)
    primary = await upsertRow(tipo, {
      ...acusePatch,
      ...(typeof saldoFavorAnterior === "number" && { ivaSaldoFavorAnterior: saldoFavorAnterior }),
      ...(ivaData && {
        ivaTrasladadoCobrado:  ivaData.trasladado  ?? null,
        ivaAcreditableGastado: ivaData.acreditable ?? null,
        ivaSaldoFavor:         ivaData.saldoFavor  ?? null,
        ivaPagar:              ivaData.pagar        ?? null,
      }),
      ...(isrData && isrFields(isrData)),
      ...(retencionesData && { retencionesIsr: retencionesData.aEnterar ?? null }),
    });
  }

  // Persist coeficiente to Company so it applies to all months of this year.
  if (typeof coeficienteUtilidad === "number" && year) {
    await prisma.company.update({
      where: { id: companyId },
      data: { coeficienteUtilidad, coeficienteAnio: year },
    });
  }

  return NextResponse.json(primary);
}
