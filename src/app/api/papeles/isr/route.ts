import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { toCsv, type CsvRow } from "@/lib/csv";
import { calcularIsrResicoPf, detectResicoKind, TARIFA_RESICO_PF_MENSUAL } from "@/lib/resico";
import { sumIsrPagar } from "@/lib/isr-provisional";
import { computeTaxPosition } from "@/lib/impuestos";

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
      select: { id: true, fecha: true, uuid: true, folio: true, serie: true, subtotal: true, customer: { select: { razonSocial: true, rfc: true } } },
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
    }),
  ]);

  // Group ingresos by month to build the monthly acumulado table
  const monthlyTotals: Array<{ month: number; ingresos: number; invoices: number }> = [];
  for (let m = 1; m <= month; m++) {
    monthlyTotals.push({ month: m, ingresos: 0, invoices: 0 });
  }
  for (const inv of ingresosYTD) {
    const m = inv.fecha.getUTCMonth() + 1;
    if (m >= 1 && m <= month) {
      monthlyTotals[m - 1].ingresos += inv.subtotal;
      monthlyTotals[m - 1].invoices += 1;
    }
  }

  // Coeficiente de utilidad (Art. 14 LISR)
  const prevIngresosTotal = prevYearIngresos._sum.subtotal ?? 0;
  const prevGastosTotal = prevYearGastos._sum.subtotal ?? 0;
  const prevUtilidad = Math.max(0, prevIngresosTotal - prevGastosTotal);
  const coeficienteCalculado = prevIngresosTotal > 0 ? prevUtilidad / prevIngresosTotal : null;

  let coeficiente: number | null;
  let coeficienteFuente: "manual" | "calculado" | "ninguno";
  if (company?.coeficienteAnio === year && company?.coeficienteUtilidad != null) {
    coeficiente = company.coeficienteUtilidad;
    coeficienteFuente = "manual";
  } else if (coeficienteCalculado != null) {
    coeficiente = coeficienteCalculado;
    coeficienteFuente = "calculado";
  } else {
    coeficiente = null;
    coeficienteFuente = "ninguno";
  }

  const ingresosAcumulados = monthlyTotals.reduce((s, m) => s + m.ingresos, 0);
  const utilidadFiscal = coeficiente != null ? ingresosAcumulados * coeficiente : null;
  const TASA_ISR = 0.30;
  const isrDelEjercicio = utilidadFiscal != null ? utilidadFiscal * TASA_ISR : null;

  // Sum ISR already paid in prior months of this year (deduped per periodo across
  // the dedicated ISR_PROVISIONAL rows and any legacy folded IVA_MENSUAL rows).
  const isrPagadoAnterior = sumIsrPagar(prevDeclaraciones);
  const isrDelMes =
    isrDelEjercicio != null ? Math.max(0, isrDelEjercicio - isrPagadoAnterior) : null;

  const MONTHS_ES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

  // Detect RESICO PF — if so, swap the calculation to Art. 113-E LISR
  // (tarifa progresiva sobre ingresos cobrados del mes, no acumulado).
  const resicoKind = detectResicoKind(company?.regimenFiscal ?? null, company?.rfc ?? null);
  const isResicoPf = resicoKind === "pf";

  // For RESICO PF, ISR is on monthly ingresos (cobrados), not acumulado
  const ingresosDelMes = monthlyTotals[monthlyTotals.length - 1]?.ingresos ?? 0;
  const resicoCalc = isResicoPf ? calcularIsrResicoPf(ingresosDelMes) : null;

  // PF con actividad empresarial/profesional (612, Art. 106): the working paper
  // must use the real flujo-de-efectivo engine, not the PM Art. 14 coeficiente
  // shape — otherwise the papel diverged from the Impuestos screen.
  const esPfActEmpresarial =
    company?.regimenFiscal === "612" && (company?.rfc?.trim().length ?? 0) === 13;
  const pfPos = esPfActEmpresarial ? await computeTaxPosition(companyId, year, month) : null;

  const payload = {
    periodo: `${year}-${String(month).padStart(2, "0")}`,
    company: company ? { rfc: company.rfc, razonSocial: company.razonSocial, regimenFiscal: company.regimenFiscal } : null,
    regimen: {
      kind: esPfActEmpresarial ? "pf_act_empresarial" : isResicoPf ? "resico_pf" : resicoKind === "pm" ? "resico_pm" : "general_pm",
      label: esPfActEmpresarial
        ? "Persona Física · Actividad Empresarial y Profesional (Art. 106 LISR)"
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
      contraparte: inv.customer?.razonSocial ?? "—",
      rfc: inv.customer?.rfc ?? "—",
      subtotal: inv.subtotal,
    })),
    calculo: esPfActEmpresarial && pfPos
      ? {
          // PF actividad empresarial (Art. 106) — straight from the engine.
          tipo: "pf_act_empresarial" as const,
          ingresosCobradosAcum: pfPos.isr.ingresosAcumulados,
          baseGravable: pfPos.isr.baseGravable,
          isrCausado: pfPos.isr.isrDelEjercicio,
          isrPagadoAnterior: pfPos.isr.isrPagadoAnterior,
          retencionesAcreditadas: pfPos.isr.retencionesAcreditadas,
          isrDelMes: pfPos.isr.isrPagar,
          tarifaVerificada: pfPos.isr.tarifaVerificada,
        }
      : isResicoPf && resicoCalc
      ? {
          // RESICO PF calculation shape
          tipo: "resico_pf" as const,
          ingresosDelMes,
          rangoLimiteInferior: resicoCalc.rangoLimiteInferior,
          rangoLimiteSuperior: resicoCalc.rangoLimiteSuperior,
          tasa: resicoCalc.tasa,
          tasaPct: resicoCalc.tasaPct,
          isrDelMes: resicoCalc.isr,
          tarifa: TARIFA_RESICO_PF_MENSUAL,
        }
      : {
          // Art. 14 LISR calculation shape (default PM)
          tipo: "art14" as const,
          ingresosAcumulados,
          coeficiente,
          utilidadFiscal,
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

    if (esPfActEmpresarial && pfPos) {
      const p = `${year}-${String(month).padStart(2, "0")}`;
      rows.push(["Régimen", "PF · Actividad Empresarial y Profesional (Art. 106 LISR)", "", ""]);
      rows.push([]);
      rows.push(["Cálculo ISR", "Ingresos cobrados (acumulado)", p, pfPos.isr.ingresosAcumulados.toFixed(2)]);
      rows.push(["Cálculo ISR", "= Base gravable", "", (pfPos.isr.baseGravable ?? 0).toFixed(2)]);
      rows.push(["Cálculo ISR", "ISR causado (tarifa Art. 96 elevada al periodo)", "", (pfPos.isr.isrDelEjercicio ?? 0).toFixed(2)]);
      rows.push(["Cálculo ISR", "− Pagos provisionales anteriores", "", pfPos.isr.isrPagadoAnterior.toFixed(2)]);
      rows.push(["Cálculo ISR", "− Retenciones 10% PM (Art. 106)", "", pfPos.isr.retencionesAcreditadas.toFixed(2)]);
      rows.push(["Cálculo ISR", "= ISR DEL MES", "", (pfPos.isr.isrPagar ?? 0).toFixed(2)]);
    } else if (isResicoPf && resicoCalc) {
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
      rows.push(["Cálculo", "= ISR DEL MES", "", resicoCalc.isr.toFixed(2)]);
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
