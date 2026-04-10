import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

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
  ] = await Promise.all([
    // This month's invoices
    prisma.invoice.findMany({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: from, lt: to } },
      include: { customer: { select: { razonSocial: true, rfc: true } }, taxes: true },
      orderBy: { fecha: "asc" },
    }),
    prisma.invoice.findMany({
      where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: from, lt: to } },
      include: { customer: { select: { razonSocial: true, rfc: true } }, taxes: true },
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
    // Saved declarations Jan → month-1 of this year (for ISR ya pagado)
    prisma.taxDeclaration.findMany({
      where: {
        companyId,
        tipo: "IVA_MENSUAL",
        periodo: { gte: `${year}-01`, lt: periodo },
        status: { in: ["CALCULATED", "FILED", "PAID"] },
      },
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
  ]);

  // ── IVA calculations ──────────────────────────────────────────────────────
  const ivaTrasladadoTotal = facturasEmitidas.reduce((sum, inv) => {
    const ivaTaxes = inv.taxes.filter((t) => t.tipo === "IVA" && !t.retencion);
    return sum + (ivaTaxes.length > 0
      ? ivaTaxes.reduce((s, t) => s + t.importe, 0)
      : (inv.totalImpuestos ?? 0));
  }, 0);

  const ivaRetenidoPorClientes = facturasEmitidas.reduce((sum, inv) =>
    sum + inv.taxes.filter((t) => t.tipo === "IVA" && t.retencion).reduce((s, t) => s + t.importe, 0), 0);

  const ivaAcreditable = facturasEgresos.reduce((sum, inv) => {
    const ivaTaxes = inv.taxes.filter((t) => t.tipo === "IVA" && !t.retencion);
    return sum + (ivaTaxes.length > 0
      ? ivaTaxes.reduce((s, t) => s + t.importe, 0)
      : (inv.totalImpuestos ?? 0));
  }, 0);

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

  if (company?.coeficienteAnio === year && company?.coeficienteUtilidad != null) {
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
  const isrPagadoAnterior  = declaracionesPrevias.reduce((s, d) => s + (d.isrPagar ?? 0), 0);

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
      trasladado: ivaTrasladadoTotal,
      retenidoPorClientes: ivaRetenidoPorClientes,
      acreditable: ivaAcreditable,
      // Auto carryover from previous month — can be overridden on frontend
      saldoFavorAnterior: saldoFavorAnteriorAuto,
      saldoFavorAnteriorPeriodo: saldoFavorAnteriorAuto > 0 ? prevPeriodo : null,
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
      // Restore any manual overrides the user saved last time
      saldoFavorAnteriorOverride: declaracionGuardada.ivaSaldoFavorAnterior,
      coeficienteOverride: declaracionGuardada.isrCoeficienteUtilidad,
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
    ivaData, isrData, status,
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

  const declarationData = {
    status: status ?? "CALCULATED",
    ivaTrasladadoCobrado:  ivaData?.trasladado  ?? null,
    ivaAcreditableGastado: ivaData?.acreditable ?? null,
    ivaSaldoFavor:         ivaData?.saldoFavor  ?? null,
    ivaPagar:              ivaData?.pagar        ?? null,
    ivaSaldoFavorAnterior: typeof saldoFavorAnterior === "number" ? saldoFavorAnterior : null,
    isrIngresos:           isrData?.ingresosAcumulados ?? null,
    isrDeducciones:        isrData?.gastosDelMes       ?? null,
    isrBaseGravable:       isrData?.utilidadFiscal     ?? null,
    isrTasa:               0.30,
    isrPagar:              isrData?.esteMes            ?? null,
    isrCoeficienteUtilidad: typeof coeficienteUtilidad === "number" ? coeficienteUtilidad : null,
    // Acuse de recibo — only update if provided
    ...(acuseUrl       !== undefined && { acuseUrl:       acuseUrl ?? null }),
    ...(lineaCaptura   !== undefined && { lineaCaptura:   lineaCaptura ?? null }),
    ...(fechaPresentacion !== undefined && {
      fechaPresentacion: fechaPresentacion ? new Date(fechaPresentacion) : null,
    }),
    ...(fechaLimitePago !== undefined && {
      fechaLimitePago: fechaLimitePago ? new Date(fechaLimitePago) : null,
    }),
  };

  const existing = await prisma.taxDeclaration.findFirst({
    where: { companyId, tipo, periodo },
  });

  const [declaration] = await Promise.all([
    // Save/update declaration
    existing
      ? prisma.taxDeclaration.update({ where: { id: existing.id }, data: declarationData })
      : prisma.taxDeclaration.create({ data: { companyId, tipo, periodo, ...declarationData } }),

    // Persist coeficiente to Company so it applies to all months of this year
    typeof coeficienteUtilidad === "number" && year
      ? prisma.company.update({
          where: { id: companyId },
          data: { coeficienteUtilidad, coeficienteAnio: year },
        })
      : Promise.resolve(null),
  ]);

  return NextResponse.json(declaration);
}
