import { prisma } from "./prisma";
import { sumIsrPagar } from "./isr-provisional";
import { detectResicoKind, calcularIsrResicoPf } from "./resico";
import { calcularIsrProvisionalPf } from "./fiscal/isr-pf";
import { calcularIsrArrendamientoMensual } from "./fiscal/isr-arrendamiento";
import { calcularIsrPlataformas, normalizarActividadPlataforma, TASAS_PLATAFORMA } from "./fiscal/isr-plataformas";
import { calcularActosDelPeriodo } from "./fiscal/iva";
import { calcularDepreciacionRegistroPeriodo } from "./fiscal/activos-registro";
import { efosRfcsBloqueados } from "./fiscal/efos/service";
import { perdidasDisponibles } from "./fiscal/perdidas";

/**
 * Prisma `where` que EXCLUYE los CFDIs de egreso emitidos por un proveedor 69-B
 * DEFINITIVO (deducción/IVA improcedente, Art. 69-B). Conserva los egresos sin
 * customer (customerId null). Vacío cuando no hay RFCs bloqueados → sin efecto.
 */
function filtroEfos(bloqueados: Set<string>): Record<string, unknown> {
  return bloqueados.size > 0 ? { NOT: { customer: { rfc: { in: [...bloqueados] } } } } : {};
}

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
  to: Date,
  /** RFCs 69-B definitivos a excluir de las deducciones (no de los ingresos). */
  efosBloqueados: Set<string> = new Set()
): Promise<{ ingresosCobrados: number; deduccionesPagadas: number; isrRetenidoCobrado: number }> {
  const efosWhere = filtroEfos(efosBloqueados);
  const [puIngreso, puEgreso, puIngresoIsrRet, repLinks] = await Promise.all([
    prisma.invoice.aggregate({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", metodoPago: "PUE", fecha: { gte: from, lt: to } },
      _sum: { subtotal: true },
    }),
    prisma.invoice.aggregate({
      // Deducciones inmediatas: excluye INVERSION (se deduce vía depreciación)
      // y SIN_EFECTOS (no deducible). Los null (legacy sin clasificar) se
      // conservan como gasto — corre el backfill de naturaleza para clasificarlos.
      // También excluye proveedores 69-B definitivos (deducción improcedente).
      where: {
        companyId, tipo: "EGRESO", status: "STAMPED", metodoPago: "PUE", fecha: { gte: from, lt: to },
        OR: [{ naturaleza: null }, { naturaleza: { notIn: ["INVERSION", "SIN_EFECTOS"] } }],
        ...efosWhere,
      },
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
          naturaleza: true,
          customer: { select: { rfc: true } },
          taxes: { where: { tipo: "ISR", retencion: true }, select: { importe: true } },
        },
      })
    : [];
  const byUuid = new Map(parents.map((p) => [p.uuid!, p]));
  const EXCLUIDAS_DEDUCCION = new Set(["INVERSION", "SIN_EFECTOS"]);
  const esEfosBloqueado = (rfc?: string | null) =>
    efosBloqueados.size > 0 && !!rfc && efosBloqueados.has(rfc.toUpperCase().trim());

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
      // INVERSION/SIN_EFECTOS no son deducción inmediata (igual que el PUE);
      // proveedor 69-B definitivo → deducción improcedente (Art. 69-B).
      if (!EXCLUIDAS_DEDUCCION.has(p.naturaleza ?? "") && !esEfosBloqueado(p.customer?.rfc)) {
        ppdEgreso += base;
      }
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
    /** IVA acreditable PROCEDENTE (ya aplicada la proporción Art. 5-V) — la cifra que entra al cálculo. */
    acreditable: number;
    /** IVA acreditable antes de proporción (suma de los gastos del periodo). */
    acreditableBruto: number;
    /** Proporción de acreditamiento (Art. 5-V LIVA): gravados/(gravados+exentos). 1 cuando no hay exentos. */
    proporcionAcreditamiento: number;
    /** Términos de la proporción — valor de actos del mes por tipo. */
    actosGravados: number;
    actosExentos: number;
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
    coeficienteFuente: "manual" | "declaracion_anual" | "provisional_previo" | "calculado" | "ninguno";
    /** Mejor coeficiente auto-detectado (anual → provisional aplicado → calculado),
     * independiente del override manual — para sugerirlo en la UI. PM only. */
    coeficienteSugerido?: number | null;
    coeficienteSugeridoFuente?: "declaracion_anual" | "provisional_previo" | "calculado" | "ninguno";
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
    /** Saldo a favor de ISR arrastrado del periodo anterior (RESICO: retención 1.25% que excedió el causado). 0 si no aplica. */
    saldoFavorAnterior: number;
    /** Saldo a favor de ISR generado este periodo — se arrastra al siguiente al guardar la declaración. 0 si no aplica. */
    saldoAFavor: number;
    /** False when the tarifa used has NOT been verified vs the authoritative source. */
    tarifaVerificada: boolean;
    /** Plataformas (625): actividad y etiqueta de la tasa aplicada; null en otros régimenes. */
    plataformaActividad?: { kind: string; label: string; asumida: boolean };
  };
  /**
   * Resumen 69-B: egresos del periodo EXCLUIDOS por provenir de un proveedor
   * definitivo (Art. 69-B) — deducción/IVA improcedente, ya descontados arriba.
   * null cuando no hay proveedores bloqueados. Cifras informativas (base bruta
   * PUE/devengado, sin ajuste de proporción ni flujo-REP) para el papel de trabajo.
   */
  efos?: {
    rfcsBloqueados: string[];
    cfdisExcluidos: number;
    subtotalExcluido: number;
    ivaAcreditableExcluido: number;
  } | null;
}

export type IsrMetodo = "PM_ART14" | "PF_ACT_EMPRESARIAL" | "RESICO_PF" | "PF_ARRENDAMIENTO" | "PF_PLATAFORMAS";

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

  // Proveedores 69-B definitivos → sus egresos NO son deducibles ni dan IVA
  // acreditable (Art. 69-B). Se excluyen de todas las consultas de egreso.
  const efosBloqueados = await efosRfcsBloqueados(companyId);
  const efosWhere = filtroEfos(efosBloqueados);

  const [
    facturasEmitidas,
    facturasEgresos,
    prevYearIngresos,
    prevYearEgresos,
    ingresosAcumuladosAgg,
    declaracionesPrevias,
    prevDeclaracion,
    prevIsrDeclaracion,
    company,
    repCobrosDelMes,
    annualDecl,
    perdidasRecords,
  ] = await Promise.all([
    prisma.invoice.findMany({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: from, lt: to } },
      include: invoiceInclude,
    }),
    prisma.invoice.findMany({
      where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: from, lt: to }, ...efosWhere },
      include: invoiceInclude,
    }),
    prisma.invoice.aggregate({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: prevYearFrom, lte: prevYearTo } },
      _sum: { subtotal: true },
      _count: { id: true },
    }),
    prisma.invoice.aggregate({
      where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: prevYearFrom, lte: prevYearTo }, ...efosWhere },
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
    // Saldo a favor de ISR del periodo anterior (RESICO PF: retención 1.25%
    // que excedió el causado). Vive en la fila ISR_PROVISIONAL guardada — la
    // cadena de arrastre depende de declaraciones guardadas, igual que el IVA.
    prisma.taxDeclaration.findFirst({
      where: {
        companyId,
        tipo: "ISR_PROVISIONAL",
        periodo: prevPeriodo,
        status: { in: ["CALCULATED", "FILED", "PAID"] },
      },
      select: { isrSaldoFavor: true },
    }),
    prisma.company.findUnique({
      where: { id: companyId },
      select: { coeficienteUtilidad: true, coeficienteAnio: true, regimenFiscal: true, rfc: true, plataformaActividad: true },
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
    // Coeficiente autoritativo: declaración anual del ejercicio anterior
    // (utilidad fiscal ÷ ingresos). El periodo de las anuales varía de formato,
    // así que se busca por prefijo del año.
    prisma.taxDeclaration.findFirst({
      where: {
        companyId,
        tipo: "DECLARACION_ANUAL",
        periodo: { startsWith: String(prevYear) },
        status: { in: ["CALCULATED", "FILED", "PAID"] },
      },
      orderBy: { periodo: "desc" },
      select: { isrIngresos: true, isrBaseGravable: true },
    }),
    // Pérdidas fiscales pendientes (Art. 57) — sólo las consume el provisional PF
    // de actividad empresarial (Art. 106); el ledger lo cierra la anual, aquí es
    // sólo lectura.
    prisma.perdidaFiscal.findMany({ where: { companyId } }),
  ]);

  // Resolve the parent PPD invoices these REP payments settle: the parent's
  // tipo decides direction (INGRESO → trasladado, EGRESO → acreditable) and its
  // IVA/total is the proration base for legacy 1.0 complementos.
  const repParentUuids = [...new Set(repCobrosDelMes.map((r) => r.parentUuid))];
  const repParents = repParentUuids.length
    ? await prisma.invoice.findMany({
        where: { companyId, uuid: { in: repParentUuids }, metodoPago: "PPD", status: "STAMPED" },
        select: { uuid: true, tipo: true, total: true, totalImpuestos: true, taxes: true, ivaNoAcreditable: true, customer: { select: { rfc: true } } },
      })
    : [];
  const repParentByUuid = new Map(repParents.map((p) => [p.uuid!, p]));
  const esEfosBloqueado = (rfc?: string | null) =>
    efosBloqueados.size > 0 && !!rfc && efosBloqueados.has(rfc.toUpperCase().trim());

  let ivaTrasladadoPPD = 0;
  let ivaAcreditablePPD = 0;
  for (const link of repCobrosDelMes) {
    const parent = repParentByUuid.get(link.parentUuid);
    if (!parent) continue; // REP references a non-PPD or unknown invoice — skip
    const iva = repIvaTrasladado(link, parent);
    if (parent.tipo === "INGRESO") ivaTrasladadoPPD += iva;
    // EGRESO de proveedor 69-B definitivo → IVA no acreditable (Art. 69-B).
    // Igual si el contador lo excluyó del acreditamiento (p. ej. no pagado).
    else if (parent.tipo === "EGRESO" && !esEfosBloqueado(parent.customer?.rfc) && !parent.ivaNoAcreditable) ivaAcreditablePPD += iva;
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
    .filter((inv) => inv.metodoPago === "PUE" && !inv.ivaNoAcreditable)
    .reduce((s, inv) => s + ivaTrasladado(inv), 0);
  const ivaAcreditableBruto = ivaAcreditablePUE + ivaAcreditablePPD;
  const ivaAcreditableDevengado = facturasEgresos.reduce((s, inv) => s + ivaTrasladado(inv), 0);

  // Proporción de acreditamiento (Art. 5-V LIVA): con actos exentos en el mes,
  // el IVA de los gastos sólo procede en gravados/(gravados+exentos). v1 trata
  // todos los gastos como indistintos (sin destino etiquetado por gasto). Sin
  // exentos la proporción es 1 y el comportamiento no cambia.
  const actos = calcularActosDelPeriodo(facturasEmitidas);
  const ivaAcreditable = round2(ivaAcreditableBruto * actos.proporcion);

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
  const esPf = (company?.rfc?.trim().length ?? 0) === 13;
  const esPfActEmpresarial = company?.regimenFiscal === "612" && esPf;
  const esPfArrendamiento = company?.regimenFiscal === "606" && esPf;
  const esPfPlataformas = company?.regimenFiscal === "625" && esPf;

  let isr: TaxPosition["isr"];

  if (esPfPlataformas) {
    // PF plataformas tecnológicas (625, Art. 113-A): tasa fija por actividad
    // sobre ingresos cobrados del mes (flujo, base-REP) − retenciones que las
    // plataformas efectuaron (del desglose del CFDI). Pago definitivo.
    const mesFlujo = await flujoEfectivoAcum(companyId, from, to, efosBloqueados);
    const asumida = !company?.plataformaActividad;
    const actividad = normalizarActividadPlataforma(company?.plataformaActividad);
    const r = calcularIsrPlataformas({
      ingresosCobradosMes: mesFlujo.ingresosCobrados,
      retencionesMes: mesFlujo.isrRetenidoCobrado,
      actividad,
    });
    isr = {
      metodo: "PF_PLATAFORMAS",
      ingresosDelMes,
      gastosDelMes,
      ingresosAcumulados: round2(r.ingresos), // cobrado del mes (definitivo, no acum.)
      isrPagadoAnterior: round2(isrPagadoAnterior),
      coeficiente: null,
      coeficienteFuente: "ninguno",
      coeficienteBase: null,
      baseGravable: r.ingresos,
      tasa: r.tasa,
      utilidadFiscal: null,
      isrDelEjercicio: r.isrCausado, // causado del mes (tasa × ingresos)
      isrPagar: r.isrPagar,
      retencionesAcreditadas: r.retenciones,
      saldoFavorAnterior: 0,
      saldoAFavor: 0,
      tarifaVerificada: true, // tasas fijas Art. 113-A (sin actualización anual)
      plataformaActividad: { kind: actividad, label: TASAS_PLATAFORMA[actividad].label, asumida },
    };
  } else if (resicoKind === "pf") {
    // RESICO PF (Art. 113-E): tarifa mensual sobre ingresos del mes (cobrado
    // approximado por ingresos stamped del mes — igual que el cálculo actual).
    const res = calcularIsrResicoPf(ingresosDelMes);
    // ISR retenido (1.25%, Art. 113-J) por los clientes personas morales sobre
    // los ingresos del mes, acreditable contra el pago definitivo del periodo.
    // Se toma lo efectivamente retenido en los CFDIs de ingreso del mes (misma
    // base que ingresosDelMes), no una tasa asumida — así un cliente que retiene
    // de menos/más queda reflejado tal cual.
    const isrRetenidoMes = round2(
      facturasEmitidas.reduce(
        (sum, inv) =>
          sum + inv.taxes.filter((t) => t.tipo === "ISR" && t.retencion).reduce((s, t) => s + t.importe, 0),
        0
      )
    );
    // Arrastre del saldo a favor: retención que excedió el causado en el
    // periodo anterior (isrSaldoFavor de la declaración guardada). No cruza
    // ejercicios — el excedente de diciembre se recupera en la declaración
    // anual (Art. 113-F), no contra enero.
    const saldoFavorIsrAnterior = month === 1 ? 0 : round2(prevIsrDeclaracion?.isrSaldoFavor ?? 0);
    const acreditableIsr = isrRetenidoMes + saldoFavorIsrAnterior;
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
      isrDelEjercicio: res.isr, // causado mensual definitivo (antes de retención)
      isrPagar: Math.max(0, round2(res.isr - acreditableIsr)),
      retencionesAcreditadas: isrRetenidoMes, // 1.25% retenido por clientes PM (Art. 113-J)
      saldoFavorAnterior: saldoFavorIsrAnterior,
      saldoAFavor: Math.max(0, round2(acreditableIsr - res.isr)),
      tarifaVerificada: true,
    };
  } else if (esPfArrendamiento) {
    // PF arrendamiento (606, Arts. 114-116): pago provisional MENSUAL
    // standalone (no acumulativo) sobre flujo — ingresos del mes efectivamente
    // cobrados (base-REP) − deducción ciega 35% (Art. 115) → tarifa mensual
    // Art. 96 − retención 10% de arrendatarios PM (Art. 116 último párrafo).
    const mes = await flujoEfectivoAcum(companyId, from, to, efosBloqueados);
    const r = calcularIsrArrendamientoMensual({
      ejercicio: year,
      ingresosCobradosMes: mes.ingresosCobrados,
      retencionesMes: mes.isrRetenidoCobrado,
    });
    isr = {
      metodo: "PF_ARRENDAMIENTO",
      ingresosDelMes,
      gastosDelMes,
      // Mensual standalone: aquí "acumulado" reporta lo cobrado del MES.
      ingresosAcumulados: r ? r.ingresos : round2(mes.ingresosCobrados),
      isrPagadoAnterior: round2(isrPagadoAnterior),
      coeficiente: null,
      coeficienteFuente: "ninguno",
      coeficienteBase: null,
      baseGravable: r ? r.baseGravable : null,
      tasa: null, // tarifa progresiva mensual
      utilidadFiscal: r ? r.baseGravable : null,
      isrDelEjercicio: r ? r.isrCausado : null, // causado del mes (provisional standalone)
      isrPagar: r ? r.isrPagar : null,
      retencionesAcreditadas: r ? r.retenciones : 0,
      saldoFavorAnterior: 0,
      saldoAFavor: 0,
      tarifaVerificada: r ? r.tarifaVerificada : false,
    };
  } else if (esPfActEmpresarial || esPf) {
    // PF con actividad empresarial (Art. 106): base en FLUJO DE EFECTIVO
    // (ingresos cobrados − deducciones pagadas, acumulado) × tarifa Art. 96.
    //
    // También es el cálculo POR DEFECTO de cualquier persona física que no caiga
    // en un régimen más específico (plataformas/RESICO/arrendamiento): una PF NUNCA
    // usa coeficiente de utilidad (eso es exclusivo de PM, Art. 14), así que jamás
    // debe terminar en la rama PM_ART14 — usa la tarifa progresiva del Art. 106.
    const { ingresosCobrados, deduccionesPagadas, isrRetenidoCobrado } = await flujoEfectivoAcum(companyId, yearFrom, to, efosBloqueados);
    // Deducción de inversiones del periodo (Art. 106): depreciación proporcional
    // ene→mes del registro de activo fijo. Los CFDIs de inversión ya quedaron
    // EXCLUIDOS de deduccionesPagadas en flujoEfectivoAcum — aquí se suma su
    // depreciación, sin doble conteo.
    const depreciacionPeriodo = await calcularDepreciacionRegistroPeriodo(companyId, year, month);
    // Pérdidas fiscales pendientes (Art. 57), actualizadas, deducibles del
    // provisional acumulado (Art. 106). El ledger lo cierra la anual; aquí sólo
    // se restan de la base — sin mutar saldos.
    const perdidasPendientes = perdidasDisponibles(
      perdidasRecords.map((p) => ({
        ejercicioOrigen: p.ejercicioOrigen,
        montoOriginal: p.montoOriginal,
        saldoActualizado: p.saldoActualizado,
        mesUltimaActualizacion: p.mesUltimaActualizacion,
        agotada: p.agotada,
        ultimoEjercicioAplicado: p.ultimoEjercicioAplicado,
      })),
      year
    ).total;
    const r = calcularIsrProvisionalPf({
      ejercicio: year,
      meses: month,
      ingresosCobradosAcum: ingresosCobrados,
      deduccionesPagadasAcum: round2(deduccionesPagadas + depreciacionPeriodo),
      perdidasFiscales: perdidasPendientes,
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
      // Art. 106 es acumulativo: una retención que excede el causado de un mes
      // se auto-corrige en el cálculo acumulado — no necesita arrastre explícito.
      saldoFavorAnterior: 0,
      saldoAFavor: 0,
      tarifaVerificada: r ? r.tarifaVerificada : false,
    };
  } else {
    // Persona MORAL general / RESICO PM / otros: Art. 14 (coeficiente × 30%
    // sobre ingresos nominales acumulados). Sólo personas morales llegan aquí —
    // cualquier persona física se resuelve arriba con tarifa/tasa (sin coeficiente).
    const prevIngresosTotal = prevYearIngresos._sum.subtotal ?? 0;
    const prevGastosTotal = prevYearEgresos._sum.subtotal ?? 0;
    const prevUtilidad = Math.max(0, prevIngresosTotal - prevGastosTotal);
    const coeficienteCalculado = prevIngresosTotal > 0 ? prevUtilidad / prevIngresosTotal : null;

    // Coeficiente del ejercicio anterior tomado de la declaración anual
    // (utilidad fiscal ÷ ingresos) — la fuente autoritativa por ley (Art. 14).
    const coeficienteAnual =
      annualDecl?.isrIngresos != null && annualDecl.isrIngresos > 0 && annualDecl.isrBaseGravable != null
        ? annualDecl.isrBaseGravable / annualDecl.isrIngresos
        : null;

    // Coeficiente que YA se aplicó en un pago provisional capturado (de un acuse
    // del SAT). Corrobora el valor real usado; el más reciente disponible.
    const coefProvRow = await prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: "ISR_PROVISIONAL", isrCoeficienteUtilidad: { not: null } },
      orderBy: { periodo: "desc" },
      select: { isrCoeficienteUtilidad: true },
    });
    const coeficienteDeclarado = coefProvRow?.isrCoeficienteUtilidad ?? null;

    // Mejor valor AUTO-detectado, independiente de un override manual: anual
    // (ley) → el aplicado en provisionales → calculado de CFDIs. Se sugiere en la
    // UI aunque el contador tenga un ajuste manual, para que pueda adoptarlo.
    const coeficienteSugerido = coeficienteAnual ?? coeficienteDeclarado ?? coeficienteCalculado;
    const coeficienteSugeridoFuente: "declaracion_anual" | "provisional_previo" | "calculado" | "ninguno" =
      coeficienteAnual != null ? "declaracion_anual"
        : coeficienteDeclarado != null ? "provisional_previo"
        : coeficienteCalculado != null ? "calculado"
        : "ninguno";

    // El APLICADO sigue la misma prioridad que el sugerido (manual → anual →
    // provisional aplicado → calculado), para que no diverjan. El coeficiente que
    // YA se enteró en un provisional es muy superior al cálculo crudo de CFDIs
    // (ingresos−egresos sobreestima la utilidad: la nómina y otras deducciones no
    // siempre vienen como egreso CFDI), así que va por encima del calculado.
    let coeficiente: number | null;
    let coeficienteFuente: "manual" | "declaracion_anual" | "provisional_previo" | "calculado" | "ninguno";
    if (company?.coeficienteUtilidad != null && (company.coeficienteAnio === year || company.coeficienteAnio == null)) {
      coeficiente = company.coeficienteUtilidad;
      coeficienteFuente = "manual";
    } else if (coeficienteAnual !== null) {
      coeficiente = coeficienteAnual;
      coeficienteFuente = "declaracion_anual";
    } else if (coeficienteDeclarado !== null) {
      coeficiente = coeficienteDeclarado;
      coeficienteFuente = "provisional_previo";
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
      coeficienteSugerido,
      coeficienteSugeridoFuente,
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
      saldoFavorAnterior: 0,
      saldoAFavor: 0,
      tarifaVerificada: true,
    };
  }

  // ── Trail 69-B: cuánto se excluyó este periodo (informativo) ──────────────
  let efos: TaxPosition["efos"] = null;
  if (efosBloqueados.size > 0) {
    const rfcs = [...efosBloqueados];
    const [aggExcl, ivaExcl] = await Promise.all([
      prisma.invoice.aggregate({
        where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: from, lt: to }, customer: { rfc: { in: rfcs } } },
        _sum: { subtotal: true },
        _count: { id: true },
      }),
      prisma.invoiceTax.aggregate({
        where: {
          tipo: "IVA", retencion: false,
          invoice: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: from, lt: to }, customer: { rfc: { in: rfcs } } },
        },
        _sum: { importe: true },
      }),
    ]);
    efos = {
      rfcsBloqueados: rfcs,
      cfdisExcluidos: aggExcl._count.id,
      subtotalExcluido: round2(aggExcl._sum.subtotal ?? 0),
      ivaAcreditableExcluido: round2(ivaExcl._sum.importe ?? 0),
    };
  }

  return {
    periodo,
    month,
    year,
    efos,
    iva: {
      trasladado: round2(ivaTrasladadoTotal),
      retenidoPorClientes: round2(ivaRetenidoPorClientes),
      acreditable: round2(ivaAcreditable),
      acreditableBruto: round2(ivaAcreditableBruto),
      proporcionAcreditamiento: actos.proporcion,
      actosGravados: actos.gravados,
      actosExentos: actos.exentos,
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
