import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { computeTaxPosition } from "@/lib/impuestos";
import { REGIMENES_ASIMILADOS, etiquetaRegimenNomina } from "@/lib/nomina/regimen";
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
  const prevPeriodo = month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, "0")}`;

  // ── Core IVA + ISR from the single engine ─────────────────────────────────
  // computeTaxPosition is THE source of truth for the tax math (régimen-aware
  // ISR + base-REP IVA, flujo de efectivo). This route only adds presentation
  // extras: the invoices table, nómina figures and saved-declaration state.
  const pos = await computeTaxPosition(companyId, year, month, isPreliminar ? to : undefined);

  // ── Presentation extras (not duplicated in the engine) ────────────────────
  const [
    facturasEmitidas,
    facturasEgresos,
    nominaThisMonth,
    declaracionGuardada,
    retencionesGuardada,
    isrProvGuardada,
  ] = await Promise.all([
    prisma.invoice.findMany({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: from, lt: to } },
      select: { id: true, uuid: true, fecha: true, subtotal: true, total: true, totalImpuestos: true,
        customer: { select: { razonSocial: true, rfc: true } } },
      orderBy: { fecha: "asc" },
    }),
    prisma.invoice.findMany({
      where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: from, lt: to } },
      select: { id: true, uuid: true, fecha: true, subtotal: true, total: true, totalImpuestos: true,
        customer: { select: { razonSocial: true, rfc: true } } },
      orderBy: { fecha: "asc" },
    }),
    // Nómina retenciones this month (informational + enteramiento status)
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
    // This month's existing IVA declaration (to restore overrides + acuse)
    prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: "IVA_MENSUAL", periodo },
      select: {
        id: true, status: true, isHistorical: true,
        ivaSaldoFavorAnterior: true, isrCoeficienteUtilidad: true,
        acuseUrl: true, lineaCaptura: true, fechaPresentacion: true, fechaLimitePago: true,
      },
    }),
    // Saved retenciones (nómina) enteramiento — its own RETENCIONES_ISR row.
    prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: "RETENCIONES_ISR", periodo },
      select: {
        id: true, status: true, retencionesIsr: true,
        acuseUrl: true, lineaCaptura: true, fechaPresentacion: true, fechaLimitePago: true,
      },
    }),
    // This period's dedicated ISR provisional row (source of the coeficiente override).
    prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: "ISR_PROVISIONAL", periodo },
      select: { id: true, status: true, isrPagar: true, isrCoeficienteUtilidad: true },
    }),
  ]);

  // ── Asimilados a salarios (Art. 94) — ingresos del receptor ────────────────
  // Recibos de nómina RECIBIDOS de un tercero bajo régimen asimilados (05–11).
  // Estos ingresos NO entran a la base de actividad empresarial: el retenedor
  // retiene el ISR (que es el pago provisional del receptor) y se acredita en la
  // declaración anual. Sólo se reconoce automáticamente — sin configurar nada.
  const asimiladosRows = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo: "NOMINA",
      status: "STAMPED",
      regimenNomina: { in: REGIMENES_ASIMILADOS },
      notas: { contains: "recib", mode: "insensitive" }, // recibidos = ingreso del receptor
      fecha: { gte: yearFrom, lt: to },
    },
    select: {
      id: true, uuid: true, fecha: true, subtotal: true,
      isrRetenidoNomina: true, regimenNomina: true,
      customer: { select: { razonSocial: true, rfc: true } },
    },
    orderBy: { fecha: "asc" },
  });
  const asimRecibos = asimiladosRows.map((r) => ({
    id: r.id,
    uuid: r.uuid,
    fecha: r.fecha,
    emisor: r.customer?.razonSocial ?? "—",
    rfc: r.customer?.rfc ?? "—",
    regimenLabel: etiquetaRegimenNomina(r.regimenNomina),
    ingreso: r.subtotal,
    isrRetenido: r.isrRetenidoNomina ?? 0,
    esDelMes: new Date(r.fecha) >= from,
  }));
  const sumA = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
  const asimDelMes = asimRecibos.filter((r) => r.esDelMes);
  const asimilados = asimRecibos.length > 0
    ? {
        recibos: asimRecibos,
        mes:   { ingreso: sumA(asimDelMes.map((r) => r.ingreso)),   isrRetenido: sumA(asimDelMes.map((r) => r.isrRetenido)) },
        anual: { ingreso: sumA(asimRecibos.map((r) => r.ingreso)), isrRetenido: sumA(asimRecibos.map((r) => r.isrRetenido)) },
      }
    : null;

  // ── Nómina retenciones ──────────────────────────────────────────────────
  const nominaIsrMes       = nominaThisMonth._sum.isrRetenido ?? 0;
  const nominaImssMes      = nominaThisMonth._sum.imssObrero ?? 0;
  const nominaImssPatronal = nominaThisMonth._sum.imssPatronal ?? 0;
  const nominaInfonavitMes = nominaThisMonth._sum.infonavit ?? 0;
  const nominaPercepMes    = nominaThisMonth._sum.totalPercepciones ?? 0;

  // ── Build unified facturas list ───────────────────────────────────────────
  type InvoiceRow = typeof facturasEmitidas[number];
  const toRow = (inv: InvoiceRow, tipo: "INGRESO" | "EGRESO") => ({
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
    // Egresos excluidos por proveedor 69-B definitivo (Art. 69-B); null si no hay.
    efos: pos.efos ?? null,
    iva: {
      // Flujo de efectivo, base-REP (what SAT actually expects) — from the engine.
      trasladado: pos.iva.trasladado,
      retenidoPorClientes: pos.iva.retenidoPorClientes,
      acreditable: pos.iva.acreditable,
      acreditableBruto: pos.iva.acreditableBruto,
      proporcionAcreditamiento: pos.iva.proporcionAcreditamiento,
      actosGravados: pos.iva.actosGravados,
      actosExentos: pos.iva.actosExentos,
      saldoFavorAnterior: pos.iva.saldoFavorAnterior,
      saldoFavorAnteriorPeriodo: pos.iva.saldoFavorAnterior > 0 ? prevPeriodo : null,
      pagar: pos.iva.pagar,
      saldoAFavor: pos.iva.saldoAFavor,
      // Devengado (informational — all stamped CFDIs regardless of payment)
      devengado: pos.iva.devengado,
    },
    // Asimilados a salarios recibidos (Art. 94) — null si la empresa no recibe.
    asimilados,
    nomina: {
      isrRetenidoMes: nominaIsrMes,
      imssObreroMes: nominaImssMes,
      imssPatronalMes: nominaImssPatronal,
      infonavitMes: nominaInfonavitMes,
      percepcionesMes: nominaPercepMes,
      // ISR retenido a enterar este mes (Art. 96 LISR — impuesto del trabajador,
      // enteramiento aparte; NO acredita contra el ISR provisional propio).
      isrRetencionesAEnterar: nominaIsrMes,
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
    // ISR provisional — régimen-aware, straight from the engine.
    isr: {
      metodo: pos.isr.metodo,
      ingresosDelMes: pos.isr.ingresosDelMes,
      gastosDelMes: pos.isr.gastosDelMes,
      ingresosAcumulados: pos.isr.ingresosAcumulados,
      isrPagadoAnterior: pos.isr.isrPagadoAnterior,
      coeficiente: pos.isr.coeficiente,
      coeficienteFuente: pos.isr.coeficienteFuente,
      coeficienteSugerido: pos.isr.coeficienteSugerido ?? null,
      coeficienteSugeridoFuente: pos.isr.coeficienteSugeridoFuente ?? null,
      coeficienteBase: pos.isr.coeficienteBase,
      baseGravable: pos.isr.baseGravable,
      tasa: pos.isr.tasa,
      utilidadFiscal: pos.isr.utilidadFiscal,
      isrDelEjercicio: pos.isr.isrDelEjercicio,
      isrPagar: pos.isr.isrPagar,
      retencionesAcreditadas: pos.isr.retencionesAcreditadas,
      saldoFavorAnterior: pos.isr.saldoFavorAnterior,
      saldoFavorAnteriorPeriodo: pos.isr.saldoFavorAnterior > 0 ? prevPeriodo : null,
      saldoAFavor: pos.isr.saldoAFavor,
      tarifaVerificada: pos.isr.tarifaVerificada,
      plataformaActividad: pos.isr.plataformaActividad ?? null,
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

  // Régimen-aware: PM sends utilidadFiscal/esteMes/tasa 0.30; PF (act. empresarial
  // o RESICO) sends baseGravable/isrPagar and tasa null (tarifa progresiva).
  const isrFields = (d: NonNullable<typeof isrData>) => ({
    isrIngresos:    d.ingresosAcumulados ?? null,
    isrDeducciones: d.gastosDelMes       ?? null,
    isrBaseGravable: (d.baseGravable ?? d.utilidadFiscal) ?? null,
    isrTasa:        d.tasa ?? null,
    isrPagar:       (d.isrPagar ?? d.esteMes) ?? null,
    // Saldo a favor RESICO (retención 1.25% que excedió el causado) — la fila
    // guardada es el eslabón del arrastre al periodo siguiente.
    isrSaldoFavor:  d.saldoAFavor ?? null,
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
