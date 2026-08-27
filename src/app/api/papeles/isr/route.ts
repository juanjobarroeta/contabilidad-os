import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { toCsv, type CsvRow } from "@/lib/csv";
import { calcularIsrResicoPf, detectResicoKind, TARIFA_RESICO_PF_MENSUAL } from "@/lib/resico";
import { DEDUCCION_CIEGA_ARRENDAMIENTO } from "@/lib/fiscal/isr-arrendamiento";
import { sumIsrPagar } from "@/lib/isr-provisional";
import { normalizarUuid, variantesUuid } from "@/lib/fiscal/uuid";
import { computeTaxPosition } from "@/lib/impuestos";
import { nombreContraparte, rfcContraparte } from "@/lib/facturas/contraparte";

// GET /api/papeles/isr?companyId=xxx&year=2026&month=3[&format=csv]
//
// Papel de trabajo del ISR provisional (Art. 14 LISR) para PMs.
//
// Estructura del cálculo que construye:
//   1. Ingresos acumulados enero → mes actual (por mes)
//   2. × coeficiente de utilidad vigente = utilidad fiscal estimada
//   3. × 30% (tasa ISR PM) = ISR del ejercicio acumulado
//   4. − pagos provisionales de meses anteriores = ISR del mes
//
// Para RESICO PF (régimen 626 PF) se usa la tarifa progresiva sobre
// ingresos en lugar del coeficiente — pero eso lo manejamos en un papel
// separado cuando implementemos RESICO (Day 3).
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const year = parseInt(searchParams.get("year") ?? "");
  const month = parseInt(searchParams.get("month") ?? "");
  const format = searchParams.get("format");

  if (!companyId || isNaN(year) || isNaN(month)) {
    return NextResponse.json({ error: "companyId, year, month requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const yearFrom = new Date(Date.UTC(year, 0, 1));
  const yearTo = new Date(Date.UTC(year, month, 1)); // exclusive

  const prevYear = year - 1;
  const prevYearFrom = new Date(Date.UTC(prevYear, 0, 1));
  const prevYearTo = new Date(Date.UTC(prevYear + 1, 0, 1));

  const [ingresosYTD, prevYearIngresos, prevYearGastos, company, prevDeclaraciones] = await Promise.all([
    prisma.invoice.findMany({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: yearFrom, lt: yearTo } },
      select: { id: true, fecha: true, uuid: true, folio: true, serie: true, subtotal: true, total: true, metodoPago: true, customer: { select: { razonSocial: true, rfc: true } } },
      orderBy: { fecha: "asc" },
    }),
    prisma.invoice.aggregate({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: prevYearFrom, lt: prevYearTo } },
      _sum: { subtotal: true },
    }),
    prisma.invoice.aggregate({
      where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: prevYearFrom, lt: prevYearTo } },
      _sum: { subtotal: true },
    }),
    prisma.company.findUnique({
      where: { id: companyId },
      select: { rfc: true, razonSocial: true, regimenFiscal: true, coeficienteUtilidad: true, coeficienteAnio: true },
    }),
    prisma.taxDeclaration.findMany({
      where: {
        companyId,
        // Both shapes: dedicated ISR_PROVISIONAL rows and legacy folded IVA_MENSUAL rows.
        tipo: { in: ["IVA_MENSUAL", "ISR_PROVISIONAL"] },
        periodo: { gte: `${year}-01`, lt: `${year}-${String(month).padStart(2, "0")}` },
        status: { in: ["CALCULATED", "FILED", "PAID"] },
      },
      select: { tipo: true, periodo: true, isrPagar: true },
    }).then((rows) => rows.map((d) => ({ ...d, isrPagar: d.isrPagar === null ? null : Number(d.isrPagar) }))),
  ]);

  // ANTICIPOS (Art. 17-I LISR): el ingreso nominal de una PM se acumula en lo
  // que ocurra PRIMERO — expedición o cobro. Un cobro documentado por REP con
  // FechaPago ANTERIOR al mes de emisión de la factura (caso real: pago 19-may,
  // factura/REP de junio) se acumula en el mes del COBRO; el resto de la
  // factura, en su mes de emisión. Sólo mueve porciones hacia atrás dentro del
  // ejercicio; el acumulado YTD no cambia (Art. 14 se autocorrige entre meses),
  // pero la tabla mensual sí — que es contra lo que cuadra el contador.
  const ppdUuids = ingresosYTD.filter((i) => i.metodoPago === "PPD" && i.uuid).map((i) => i.uuid!);
  const anticipoLinks = ppdUuids.length
    ? await prisma.pagoDoctoRelacionado.findMany({
        where: {
          parentUuid: { in: variantesUuid(ppdUuids) },
          fechaPago: { gte: yearFrom, lt: yearTo },
          pagoInvoice: { companyId, tipo: "PAGO", status: "STAMPED" },
        },
        select: { parentUuid: true, impPagado: true, fechaPago: true },
      })
    : [];
  const linksPorParent = new Map<string, { impPagado: number | null; fechaPago: Date | null }[]>();
  for (const l of anticipoLinks) {
    const k = normalizarUuid(l.parentUuid);
    linksPorParent.set(k, [...(linksPorParent.get(k) ?? []), { ...l, impPagado: l.impPagado === null ? null : Number(l.impPagado) }]);
  }

  // Group ingresos by month to build the monthly acumulado table
  const monthlyTotals: Array<{ month: number; ingresos: number; invoices: number }> = [];
  for (let m = 1; m <= month; m++) {
    monthlyTotals.push({ month: m, ingresos: 0, invoices: 0 });
  }
  let anticiposReubicados = 0;
  let anticiposMonto = 0;
  for (const inv of ingresosYTD) {
    const m = inv.fecha.getUTCMonth() + 1;
    if (m < 1 || m > month) continue;
    monthlyTotals[m - 1].invoices += 1;

    const subtotal = Number(inv.subtotal);
    const total = Number(inv.total);
    let restante = subtotal;
    const links = inv.uuid ? (linksPorParent.get(normalizarUuid(inv.uuid)) ?? []) : [];
    for (const l of links) {
      if (!l.fechaPago || l.impPagado == null || total <= 0) continue;
      const mPago = l.fechaPago.getUTCMonth() + 1;
      if (mPago >= m || mPago < 1 || mPago > month) continue; // sólo cobros ANTERIORES a la emisión
      // Equivalente en subtotal del pago (el REP trae importes con IVA).
      const porcion = Math.min(restante, l.impPagado * (subtotal / total));
      if (porcion <= 0) continue;
      monthlyTotals[mPago - 1].ingresos += porcion;
      restante -= porcion;
      anticiposReubicados += 1;
      anticiposMonto += porcion;
    }
    monthlyTotals[m - 1].ingresos += restante;
  }

  // Cifras históricas del ejercicio anterior (sólo informativas para el papel).
  // El coeficiente crudo (ingresos−egresos)/ingresos se muestra como referencia,
  // pero NO es el que se aplica ni el que se sugiere: ambos vienen del motor
  // (computeTaxPosition) para no divergir de la pantalla de Impuestos.
  const prevIngresosTotal = Number(prevYearIngresos._sum.subtotal ?? 0);
  const prevGastosTotal = Number(prevYearGastos._sum.subtotal ?? 0);
  const prevUtilidad = Math.max(0, prevIngresosTotal - prevGastosTotal);
  const coeficienteCalculado = prevIngresosTotal > 0 ? prevUtilidad / prevIngresosTotal : null;

  const ingresosAcumulados = monthlyTotals.reduce((s, m) => s + m.ingresos, 0);
  const TASA_ISR = 0.30;

  const MONTHS_ES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

  // Detect RESICO PF — if so, swap the calculation to Art. 113-E LISR
  // (tarifa progresiva sobre ingresos cobrados del mes, no acumulado).
  const resicoKind = detectResicoKind(company?.regimenFiscal ?? null, company?.rfc ?? null);
  const isResicoPf = resicoKind === "pf";

  // El motor (computeTaxPosition) es la ÚNICA fuente de verdad del coeficiente y
  // del cálculo del ISR para todos los regímenes:
  //   · PF act. empresarial (612, Art. 106), RESICO PF (Art. 113-E), PF
  //     arrendamiento (606, Arts. 114-116) y plataformas (625) — incluida la
  //     retención acreditada.
  //   · Persona Moral Art. 14 — el coeficiente APLICADO y el SUGERIDO siguen la
  //     prioridad legal (manual → declaración anual → provisional capturado →
  //     calculado de CFDIs) que define el motor, para que el papel no proponga
  //     un coeficiente crudo equivocado.
  const esPf = (company?.rfc?.trim().length ?? 0) === 13;
  const esPfActEmpresarial = company?.regimenFiscal === "612" && esPf;
  const esPfArrendamiento = company?.regimenFiscal === "606" && esPf;
  const esPfPlataformas = company?.regimenFiscal === "625" && esPf;
  const enginePos = await computeTaxPosition(companyId, year, month);

  // Coeficiente aplicado + sugerido tomados del motor (única fuente de verdad).
  const coeficiente = enginePos.isr.coeficiente ?? null;
  const coeficienteFuente = enginePos.isr.coeficienteFuente ?? "ninguno";
  const coeficienteSugerido = enginePos.isr.coeficienteSugerido ?? null;
  const coeficienteSugeridoFuente = enginePos.isr.coeficienteSugeridoFuente ?? "ninguno";

  // Cifras del cálculo Art. 14 (PM) — también del motor para no recalcular.
  const utilidadFiscal = enginePos.isr.utilidadFiscal ?? (coeficiente != null ? ingresosAcumulados * coeficiente : null);
  const isrPagadoAnterior = enginePos.isr.isrPagadoAnterior ?? sumIsrPagar(prevDeclaraciones);
  const isrDelEjercicio = enginePos.isr.isrDelEjercicio ?? null;
  const isrDelMes = enginePos.isr.isrPagar ?? null;

  // For RESICO PF, ISR is on monthly ingresos (cobrados), not acumulado — tomado
  // del motor para coincidir con la pantalla. El rango/tasa de la tarifa se
  // obtienen de la función pura sobre ese mismo ingreso.
  const ingresosDelMes = enginePos?.isr.ingresosDelMes ?? monthlyTotals[monthlyTotals.length - 1]?.ingresos ?? 0;
  const resicoCalc = isResicoPf && enginePos ? calcularIsrResicoPf(ingresosDelMes) : null;

  const payload = {
    periodo: `${year}-${String(month).padStart(2, "0")}`,
    company: company ? { rfc: company.rfc, razonSocial: company.razonSocial, regimenFiscal: company.regimenFiscal } : null,
    // Cobros anticipados reubicados a su mes de cobro (Art. 17-I LISR).
    anticipos: { movimientos: anticiposReubicados, monto: +anticiposMonto.toFixed(2) },
    regimen: {
      kind: esPfActEmpresarial
        ? "pf_act_empresarial"
        : esPfArrendamiento
        ? "pf_arrendamiento"
        : esPfPlataformas
        ? "pf_plataformas"
        : isResicoPf
        ? "resico_pf"
        : resicoKind === "pm"
        ? "resico_pm"
        : "general_pm",
      label: esPfActEmpresarial
        ? "Persona Física · Actividad Empresarial y Profesional (Art. 106 LISR)"
        : esPfArrendamiento
        ? "Persona Física · Arrendamiento (Arts. 114-116 LISR)"
        : esPfPlataformas
        ? "Persona Física · Plataformas Tecnológicas (Art. 113-A LISR)"
        : isResicoPf
        ? "RESICO Persona Física (Art. 113-E LISR)"
        : resicoKind === "pm"
          ? "RESICO Persona Moral (Art. 14 LISR con flujo)"
          : "Persona Moral Art. 14 LISR",
    },
    base: {
      prevYear,
      prevIngresosTotal,
      prevGastosTotal,
      prevUtilidad,
      coeficienteCalculado,
      coeficiente,
      coeficienteFuente,
      coeficienteSugerido,
      coeficienteSugeridoFuente,
      perdidaFiscalPendiente: enginePos.isr.perdidaFiscalPendiente ?? null,
    },
    acumulado: monthlyTotals.map((m) => ({
      mes: m.month,
      mesLabel: MONTHS_ES[m.month - 1],
      ingresos: m.ingresos,
      facturas: m.invoices,
    })),
    invoices: ingresosYTD.filter(i => i.fecha >= new Date(Date.UTC(year, month - 1, 1)) && i.fecha < yearTo).map((inv) => ({
      id: inv.id,
      fecha: inv.fecha.toISOString().slice(0, 10),
      uuid: inv.uuid,
      serie: inv.serie,
      folio: inv.folio,
      contraparte: nombreContraparte(inv),
      rfc: rfcContraparte(inv),
      subtotal: inv.subtotal,
    })),
    calculo: esPfPlataformas && enginePos
      ? {
          // PF plataformas (Art. 113-A) — tasa fija × ingresos − retenciones.
          tipo: "pf_plataformas" as const,
          ingresosCobradosMes: enginePos.isr.ingresosAcumulados,
          actividad: enginePos.isr.plataformaActividad?.label ?? "",
          actividadAsumida: enginePos.isr.plataformaActividad?.asumida ?? false,
          tasa: enginePos.isr.tasa,
          isrCausado: enginePos.isr.isrDelEjercicio,
          retencionesAcreditadas: enginePos.isr.retencionesAcreditadas,
          isrDelMes: enginePos.isr.isrPagar,
        }
      : esPfArrendamiento && enginePos
      ? {
          // PF arrendamiento (Arts. 114-116) — mensual standalone, del motor.
          tipo: "pf_arrendamiento" as const,
          ingresosCobradosMes: enginePos.isr.ingresosAcumulados,
          deduccionCiega: +(enginePos.isr.ingresosAcumulados * DEDUCCION_CIEGA_ARRENDAMIENTO).toFixed(2),
          // Predial pagado del mes: se deduce ADEMÁS de la ciega (Art. 115).
          // Va explícito para que la resta cuadre en pantalla.
          predialPagado: enginePos.isr.predialPagado ?? 0,
          baseGravable: enginePos.isr.baseGravable,
          isrCausado: enginePos.isr.isrDelEjercicio,
          retencionesAcreditadas: enginePos.isr.retencionesAcreditadas,
          isrDelMes: enginePos.isr.isrPagar,
          tarifaVerificada: enginePos.isr.tarifaVerificada,
        }
      : esPfActEmpresarial && enginePos
      ? {
          // PF actividad empresarial (Art. 106) — straight from the engine.
          tipo: "pf_act_empresarial" as const,
          ingresosCobradosAcum: enginePos.isr.ingresosAcumulados,
          baseGravable: enginePos.isr.baseGravable,
          isrCausado: enginePos.isr.isrDelEjercicio,
          isrPagadoAnterior: enginePos.isr.isrPagadoAnterior,
          retencionesAcreditadas: enginePos.isr.retencionesAcreditadas,
          isrDelMes: enginePos.isr.isrPagar,
          tarifaVerificada: enginePos.isr.tarifaVerificada,
        }
      : isResicoPf && resicoCalc && enginePos
      ? {
          // RESICO PF (Art. 113-E) — causado del motor menos la retención 1.25%
          // (Art. 113-J) ya acreditada, para coincidir con la pantalla.
          tipo: "resico_pf" as const,
          ingresosDelMes,
          rangoLimiteInferior: resicoCalc.rangoLimiteInferior,
          rangoLimiteSuperior: resicoCalc.rangoLimiteSuperior,
          tasa: resicoCalc.tasa,
          tasaPct: resicoCalc.tasaPct,
          isrCausado: enginePos.isr.isrDelEjercicio ?? resicoCalc.isr,
          retencionesAcreditadas: enginePos.isr.retencionesAcreditadas,
          saldoFavorAnterior: enginePos.isr.saldoFavorAnterior,
          saldoAFavor: enginePos.isr.saldoAFavor,
          isrDelMes: enginePos.isr.isrPagar ?? resicoCalc.isr,
          tarifa: TARIFA_RESICO_PF_MENSUAL,
        }
      : {
          // Art. 14 LISR calculation shape (default PM)
          tipo: "art14" as const,
          ingresosAcumulados,
          coeficiente,
          utilidadFiscal,
          baseGravable: enginePos.isr.baseGravable ?? null,
          // PTU pagada en el ejercicio disminuida en octavos may–dic, ANTES de
          // pérdidas (Art. 14, fracc. II, segundo párrafo LISR).
          ptuPagadaEjercicio: enginePos.isr.ptuPagadaEjercicio ?? null,
          ptuDisminuida: enginePos.isr.ptuDisminuida ?? null,
          perdidaFiscalAplicada: enginePos.isr.perdidaFiscalAplicada ?? null,
          tasa: TASA_ISR,
          isrDelEjercicio,
          isrPagadoAnterior,
          isrDelMes,
          declaracionesAnteriores: prevDeclaraciones,
        },
  };

  if (format === "csv") {
    const headers = [
      "Sección",
      "Concepto",
      "Periodo",
      "Monto",
    ];
    const rows: CsvRow[] = [];

    if (esPfPlataformas && enginePos) {
      const p = `${year}-${String(month).padStart(2, "0")}`;
      rows.push(["Régimen", "PF · Plataformas Tecnológicas (Art. 113-A LISR)", "", ""]);
      rows.push([]);
      rows.push(["Cálculo ISR", `Actividad: ${enginePos.isr.plataformaActividad?.label ?? "—"}`, "", ""]);
      rows.push(["Cálculo ISR", "Ingresos cobrados del mes", p, enginePos.isr.ingresosAcumulados.toFixed(2)]);
      rows.push(["Cálculo ISR", `× Tasa (${((enginePos.isr.tasa ?? 0) * 100).toFixed(2)}%)`, "", ""]);
      rows.push(["Cálculo ISR", "= ISR causado", "", (enginePos.isr.isrDelEjercicio ?? 0).toFixed(2)]);
      rows.push(["Cálculo ISR", "− Retenciones de plataformas", "", enginePos.isr.retencionesAcreditadas.toFixed(2)]);
      rows.push(["Cálculo ISR", "= ISR DEL MES", "", (enginePos.isr.isrPagar ?? 0).toFixed(2)]);
    } else if (esPfArrendamiento && enginePos) {
      const p = `${year}-${String(month).padStart(2, "0")}`;
      rows.push(["Régimen", "PF · Arrendamiento (Arts. 114-116 LISR)", "", ""]);
      rows.push([]);
      rows.push(["Cálculo ISR", "Ingresos cobrados del mes", p, enginePos.isr.ingresosAcumulados.toFixed(2)]);
      rows.push(["Cálculo ISR", `− Deducción ciega ${(DEDUCCION_CIEGA_ARRENDAMIENTO * 100).toFixed(0)}% (Art. 115)`, "", (enginePos.isr.ingresosAcumulados * DEDUCCION_CIEGA_ARRENDAMIENTO).toFixed(2)]);
      rows.push(["Cálculo ISR", "= Base gravable", "", (enginePos.isr.baseGravable ?? 0).toFixed(2)]);
      rows.push(["Cálculo ISR", "ISR causado (tarifa mensual Art. 96)", "", (enginePos.isr.isrDelEjercicio ?? 0).toFixed(2)]);
      rows.push(["Cálculo ISR", "− Retenciones 10% PM (Art. 116)", "", enginePos.isr.retencionesAcreditadas.toFixed(2)]);
      rows.push(["Cálculo ISR", "= ISR DEL MES", "", (enginePos.isr.isrPagar ?? 0).toFixed(2)]);
    } else if (esPfActEmpresarial && enginePos) {
      const p = `${year}-${String(month).padStart(2, "0")}`;
      rows.push(["Régimen", "PF · Actividad Empresarial y Profesional (Art. 106 LISR)", "", ""]);
      rows.push([]);
      rows.push(["Cálculo ISR", "Ingresos cobrados (acumulado)", p, enginePos.isr.ingresosAcumulados.toFixed(2)]);
      rows.push(["Cálculo ISR", "= Base gravable", "", (enginePos.isr.baseGravable ?? 0).toFixed(2)]);
      rows.push(["Cálculo ISR", "ISR causado (tarifa Art. 96 elevada al periodo)", "", (enginePos.isr.isrDelEjercicio ?? 0).toFixed(2)]);
      rows.push(["Cálculo ISR", "− Pagos provisionales anteriores", "", enginePos.isr.isrPagadoAnterior.toFixed(2)]);
      rows.push(["Cálculo ISR", "− Retenciones 10% PM (Art. 106)", "", enginePos.isr.retencionesAcreditadas.toFixed(2)]);
      rows.push(["Cálculo ISR", "= ISR DEL MES", "", (enginePos.isr.isrPagar ?? 0).toFixed(2)]);
    } else if (isResicoPf && resicoCalc && enginePos) {
      rows.push(["Régimen", "RESICO Persona Física (Art. 113-E LISR)", "", ""]);
      rows.push([]);
      rows.push(["Tarifa RESICO PF mensual", "", "", ""]);
      for (const tr of TARIFA_RESICO_PF_MENSUAL) {
        rows.push([
          "Tarifa RESICO PF mensual",
          `${tr.limiteInferior.toFixed(2)} — ${tr.limiteSuperior === Infinity ? "en adelante" : tr.limiteSuperior.toFixed(2)}`,
          "",
          tr.tasaPct,
        ]);
      }
      rows.push([]);
      rows.push(["Cálculo", "Ingresos cobrados del mes", `${year}-${String(month).padStart(2, "0")}`, ingresosDelMes.toFixed(2)]);
      rows.push(["Cálculo", `Rango aplicable (${resicoCalc.tasaPct})`, "", `${resicoCalc.rangoLimiteInferior.toFixed(2)} — ${resicoCalc.rangoLimiteSuperior === Infinity ? "∞" : resicoCalc.rangoLimiteSuperior.toFixed(2)}`]);
      rows.push(["Cálculo", "× Tasa", "", resicoCalc.tasaPct]);
      rows.push(["Cálculo", "= ISR causado", "", (enginePos.isr.isrDelEjercicio ?? resicoCalc.isr).toFixed(2)]);
      rows.push(["Cálculo", "− Retenciones 1.25% PM (Art. 113-J)", "", enginePos.isr.retencionesAcreditadas.toFixed(2)]);
      if (enginePos.isr.saldoFavorAnterior > 0) {
        rows.push(["Cálculo", "− Saldo a favor del periodo anterior", "", enginePos.isr.saldoFavorAnterior.toFixed(2)]);
      }
      rows.push(["Cálculo", "= ISR DEL MES", "", (enginePos.isr.isrPagar ?? resicoCalc.isr).toFixed(2)]);
      if (enginePos.isr.saldoAFavor > 0) {
        rows.push(["Cálculo", "Saldo a favor que se arrastra al siguiente periodo", "", enginePos.isr.saldoAFavor.toFixed(2)]);
      }
    } else {
      rows.push(["Base histórica", `Ingresos ${prevYear}`, String(prevYear), prevIngresosTotal.toFixed(2)]);
      rows.push(["Base histórica", `Gastos ${prevYear}`, String(prevYear), prevGastosTotal.toFixed(2)]);
      rows.push(["Base histórica", `Utilidad ${prevYear}`, String(prevYear), prevUtilidad.toFixed(2)]);
      rows.push(["Base histórica", "Coeficiente de utilidad calculado", String(prevYear), coeficienteCalculado != null ? (coeficienteCalculado * 100).toFixed(4) + "%" : ""]);
      rows.push(["Base histórica", `Coeficiente aplicado (${coeficienteFuente})`, String(year), coeficiente != null ? (coeficiente * 100).toFixed(4) + "%" : ""]);
      rows.push([]);

      rows.push(["Ingresos acumulados", "", "", ""]);
      for (const m of monthlyTotals) {
        rows.push(["Ingresos acumulados", MONTHS_ES[m.month - 1], `${year}-${String(m.month).padStart(2, "0")}`, m.ingresos.toFixed(2)]);
      }
      rows.push(["Ingresos acumulados", "Total", "", ingresosAcumulados.toFixed(2)]);
      rows.push([]);

      rows.push(["Cálculo ISR", "Ingresos acumulados", "", ingresosAcumulados.toFixed(2)]);
      rows.push(["Cálculo ISR", "× Coeficiente", "", coeficiente != null ? (coeficiente * 100).toFixed(4) + "%" : "—"]);
      rows.push(["Cálculo ISR", "= Utilidad fiscal estimada", "", utilidadFiscal != null ? utilidadFiscal.toFixed(2) : "—"]);
      // PTU pagada en el ejercicio, disminuida en octavos acumulados de mayo a
      // diciembre ANTES de amortizar pérdidas (Art. 14, fracc. II LISR); luego
      // pérdidas fiscales pendientes. Renglones sólo cuando hubo disminución.
      const csvPtu = enginePos.isr.ptuDisminuida ?? 0;
      const csvPerdida = enginePos.isr.perdidaFiscalAplicada ?? 0;
      if (csvPtu > 0) {
        rows.push(["Cálculo ISR", "− PTU pagada en el ejercicio (octavos mayo–diciembre, Art. 14 fracc. II)", "", csvPtu.toFixed(2)]);
      }
      if (csvPerdida > 0) {
        rows.push(["Cálculo ISR", "− Pérdidas fiscales de ejercicios anteriores aplicadas", "", csvPerdida.toFixed(2)]);
      }
      if (csvPtu > 0 || csvPerdida > 0) {
        rows.push(["Cálculo ISR", "= Base gravable", "", enginePos.isr.baseGravable != null ? enginePos.isr.baseGravable.toFixed(2) : "—"]);
      }
      rows.push(["Cálculo ISR", "× Tasa ISR", "", (TASA_ISR * 100).toFixed(0) + "%"]);
      rows.push(["Cálculo ISR", "= ISR del ejercicio acumulado", "", isrDelEjercicio != null ? isrDelEjercicio.toFixed(2) : "—"]);
      rows.push(["Cálculo ISR", "− ISR pagado en meses anteriores", "", isrPagadoAnterior.toFixed(2)]);
      rows.push(["Cálculo ISR", "= ISR DEL MES", "", isrDelMes != null ? isrDelMes.toFixed(2) : "—"]);
    }

    const csv = toCsv(headers, rows);
    const filename = `papel_isr_${company?.rfc ?? ""}_${year}-${String(month).padStart(2, "0")}.csv`;
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  return NextResponse.json(payload);
}
