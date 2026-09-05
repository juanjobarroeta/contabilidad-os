import { prisma } from "./prisma";
import { sumIsrPagar } from "./isr-provisional";
import { detectResicoKind, calcularIsrResicoPf } from "./resico";
import { calcularIsrProvisionalPf } from "./fiscal/isr-pf";
import { calcularIsrArrendamientoMensual, esErogacionPredial } from "./fiscal/isr-arrendamiento";
import { calcularIsrPlataformas, normalizarActividadPlataforma, TASAS_PLATAFORMA } from "./fiscal/isr-plataformas";
import { calcularActosDelPeriodo } from "./fiscal/iva";
import { calcularDepreciacionRegistroPeriodo } from "./fiscal/activos-registro";
import { efosRfcsBloqueados } from "./fiscal/efos/service";
import { perdidasDisponibles } from "./fiscal/perdidas";
import { ivaTrasladadoDe, repIvaTrasladadoDe } from "./fiscal/iva-flujo";
import { ivaAcreditableNetoDe, ivaRetenidoDe, isrRetenidoDe, repIsrRetenidoDe, repIvaRetenidoDe } from "./fiscal/iva-retenciones";
import { ivaRetenidoAProveedoresEnPeriodo } from "./fiscal/iva-retenciones-db";
import { normalizarUuid, variantesUuid } from "./fiscal/uuid";

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

// Helpers puros de flujo (IVA trasladado por factura y por pago de REP) —
// extraídos a src/lib/fiscal/iva-flujo.ts para compartirlos con la DIOT.
// Se re-exportan con sus nombres históricos para no romper a los llamadores.
/**
 * Signo fiscal por TipoDeComprobante: una nota de crédito ("E") NETEA con signo
 * negativo dentro de su tipo (emitida reduce ingresos e IVA trasladado;
 * recibida reduce deducciones e IVA acreditable). Null/I → +1 (legado = I).
 */
export function signoTipoSat(tipoSat: string | null | undefined): 1 | -1 {
  return tipoSat === "E" ? -1 : 1;
}

export type { InvoiceLike } from "./fiscal/iva-flujo";
export { ivaTrasladadoDe, repIvaTrasladadoDe as repIvaAcreditableDe } from "./fiscal/iva-flujo";
const ivaTrasladado = ivaTrasladadoDe;
const repIvaTrasladado = repIvaTrasladadoDe;

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

  // Notas de crédito ("E") dentro de los mismos filtros: netean en negativo.
  const [puIngresoE, puEgresoE] = await Promise.all([
    prisma.invoice.aggregate({
      where: { companyId, tipo: "INGRESO", tipoSat: "E", status: "STAMPED", metodoPago: "PUE", fecha: { gte: from, lt: to } },
      _sum: { subtotal: true },
    }),
    prisma.invoice.aggregate({
      where: {
        companyId, tipo: "EGRESO", tipoSat: "E", status: "STAMPED", metodoPago: "PUE", fecha: { gte: from, lt: to },
        OR: [{ naturaleza: null }, { naturaleza: { notIn: ["INVERSION", "SIN_EFECTOS"] } }],
        ...efosWhere,
      },
      _sum: { subtotal: true },
    }),
  ]);

  // Empate por UUID normalizado: el REP referencia en MAYÚSCULAS y las
  // facturas del PAC se guardan en minúsculas (ver src/lib/fiscal/uuid.ts).
  const uuids = variantesUuid(repLinks.map((l) => l.parentUuid));
  const parents = uuids.length
    ? await prisma.invoice.findMany({
        where: { companyId, uuid: { in: uuids }, metodoPago: "PPD", status: "STAMPED" },
        select: {
          uuid: true,
          tipo: true,
          tipoSat: true,
          subtotal: true,
          total: true,
          naturaleza: true,
          customer: { select: { rfc: true } },
          taxes: { where: { tipo: "ISR", retencion: true }, select: { importe: true } },
        },
      }).then((rows) => rows.map((p) => ({ ...p, subtotal: Number(p.subtotal), total: Number(p.total), taxes: p.taxes.map((t) => ({ ...t, importe: Number(t.importe) })) })))
    : [];
  const byUuid = new Map(parents.map((p) => [normalizarUuid(p.uuid!), p]));
  const EXCLUIDAS_DEDUCCION = new Set(["INVERSION", "SIN_EFECTOS"]);
  const esEfosBloqueado = (rfc?: string | null) =>
    efosBloqueados.size > 0 && !!rfc && efosBloqueados.has(rfc.toUpperCase().trim());

  let ppdIngreso = 0;
  let ppdEgreso = 0;
  let ppdIsrRetenido = 0;
  for (const l of repLinks) {
    const p = byUuid.get(normalizarUuid(l.parentUuid));
    if (!p || p.total <= 0 || l.impPagado == null) continue;
    const fraccionPagada = Number(l.impPagado) / p.total;
    const base = Number(l.impPagado) * (p.subtotal / p.total); // subtotal-equivalent collected/paid
    const signoNota = signoTipoSat(p.tipoSat);
    if (p.tipo === "INGRESO") {
      ppdIngreso += signoNota * base;
      const parentIsrRet = p.taxes.reduce((s, t) => s + t.importe, 0);
      ppdIsrRetenido += parentIsrRet * fraccionPagada; // retención del ingreso cobrado
    } else if (p.tipo === "EGRESO") {
      // INVERSION/SIN_EFECTOS no son deducción inmediata (igual que el PUE);
      // proveedor 69-B definitivo → deducción improcedente (Art. 69-B).
      if (!EXCLUIDAS_DEDUCCION.has(p.naturaleza ?? "") && !esEfosBloqueado(p.customer?.rfc)) {
        ppdEgreso += signoNota * base;
      }
    }
  }

  return {
    // El agregado positivo INCLUYE las notas "E" (+), así que el neto es
    // total − 2·E (una vez para quitarlas, otra para restarlas).
    ingresosCobrados: Number(puIngreso._sum.subtotal ?? 0) - 2 * Number(puIngresoE._sum.subtotal ?? 0) + ppdIngreso,
    deduccionesPagadas: Number(puEgreso._sum.subtotal ?? 0) - 2 * Number(puEgresoE._sum.subtotal ?? 0) + ppdEgreso,
    isrRetenidoCobrado: Number(puIngresoIsrRet._sum.importe ?? 0) + ppdIsrRetenido,
  };
}

export interface TaxPosition {
  periodo: string;
  month: number;
  year: number;
  iva: {
    trasladado: number;
    retenidoPorClientes: number;
    /**
     * IVA que retuvimos a proveedores en el mes (flujo: PUE al emitirse, PPD con
     * cada REP) — pasivo a ENTERAR junto con la declaración (Art. 1-A LIVA). No
     * reduce nuestro IVA a cargo, pero sí es dinero que sale: ver totalConRetenciones.
     */
    retenidoAProveedores: number;
    /**
     * IVA que retuvimos el MES ANTERIOR y (se asume) enteramos con esa
     * declaración: es acreditable en ésta (Art. 5-IV LIVA). Ya está incluido en
     * `acreditableBruto`/`acreditable`; se expone para mostrarlo como línea.
     */
    retenidoMesAnteriorAcreditable: number;
    /** IVA a pagar + retenciones a enterar: lo que realmente sale hacia el SAT por IVA este mes. */
    totalConRetenciones: number;
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
    /** Remanente de pérdidas fiscales pendiente de aplicar (actualizado). PM Art.14; null en otros régimenes. */
    perdidaFiscalPendiente?: number | null;
    /** Pérdida fiscal efectivamente amortizada contra la utilidad este periodo. PM Art.14; null en otros régimenes. */
    perdidaFiscalAplicada?: number | null;
    /** PTU pagada en el ejercicio en curso (suma de PayrollItem.ptu de las corridas de nómina del año, al cierre del periodo). PM Art.14; null en otros régimenes. */
    ptuPagadaEjercicio?: number | null;
    /** PTU disminuida de la utilidad fiscal este periodo — octavos acumulados mayo–diciembre, capada a la utilidad (Art. 14, fracc. II, segundo párrafo LISR). PM Art.14; null en otros régimenes. */
    ptuDisminuida?: number | null;
    isrDelEjercicio: number | null;
    isrPagar: number | null;
    /** ISR retenido (Art. 106, 10% por PM) acreditado contra el provisional. 0 si no aplica al régimen. */
    retencionesAcreditadas: number;
    /**
     * ISR que NOSOTROS retuvimos a proveedores personas físicas en el mes
     * (honorarios 10% Art. 106, arrendamiento Art. 116; flujo: PUE al emitirse,
     * PPD con cada REP) — pasivo a ENTERAR con la declaración. No afecta el
     * provisional propio. Se rellena al final para todos los regímenes.
     */
    retenidoAProveedoresEnterar: number;
    /** Saldo a favor de ISR arrastrado del periodo anterior (RESICO: retención 1.25% que excedió el causado). 0 si no aplica. */
    saldoFavorAnterior: number;
    /** Saldo a favor de ISR generado este periodo — se arrastra al siguiente al guardar la declaración. 0 si no aplica. */
    saldoAFavor: number;
    /** False when the tarifa used has NOT been verified vs the authoritative source. */
    tarifaVerificada: boolean;
    /** Plataformas (625): actividad y etiqueta de la tasa aplicada; null en otros régimenes. */
    plataformaActividad?: { kind: string; label: string; asumida: boolean };
    /** Arrendamiento (606): predial pagado del mes, deducible ADEMÁS de la
     *  ciega del 35% (Art. 115). Undefined en los demás régimenes. */
    predialPagado?: number;
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
  /**
   * Avisos de integridad de la cadena de arrastre (español formal, listos para
   * mostrar). El motor lee el saldo a favor de IVA (Art. 6 LIVA) y los pagos
   * provisionales de ISR (Art. 14 LISR) de las declaraciones GUARDADAS de meses
   * anteriores: si un mes con actividad nunca se guardó, esos arrastres valen 0
   * en silencio y el IVA/ISR del periodo se sobrestima. Vacío = cadena íntegra.
   */
  advertencias: string[];
}

export type IsrMetodo = "PM_ART14" | "PF_ACT_EMPRESARIAL" | "RESICO_PF" | "PF_ARRENDAMIENTO" | "PF_PLATAFORMAS";

const ISR_TASA_PM = 0.3;

/**
 * Amortización de pérdidas fiscales de ejercicios anteriores (Art. 14 LISR) en
 * pagos provisionales de Persona Moral. La pérdida pendiente (ACTUALIZADA, el
 * remanente de la última declaración anual) se resta de la utilidad fiscal
 * estimada antes de aplicar la tasa del 30%. Sólo aplica cuando el remanente es
 * positivo y corresponde a un ejercicio ANTERIOR al que se calcula.
 *
 * Función pura (sin DB) para poder probar la matemática de forma aislada.
 */
export function aplicarPerdidaFiscalPM(params: {
  utilidadFiscal: number;
  perdidaPendiente: number | null;
  perdidaAnio: number | null;
  year: number;
}): { perdidaAplicada: number; baseGravable: number } {
  const { utilidadFiscal, perdidaPendiente, perdidaAnio, year } = params;
  const aplicable =
    perdidaPendiente != null &&
    perdidaPendiente > 0 &&
    (perdidaAnio == null || perdidaAnio < year);
  if (!aplicable || utilidadFiscal <= 0) {
    return { perdidaAplicada: 0, baseGravable: Math.max(0, round2(utilidadFiscal)) };
  }
  const perdidaAplicada = round2(Math.min(perdidaPendiente!, utilidadFiscal));
  const baseGravable = Math.max(0, round2(utilidadFiscal - perdidaAplicada));
  return { perdidaAplicada, baseGravable };
}

/**
 * PTU pagada en el ejercicio disminuible del pago provisional (Art. 14,
 * fracc. II, segundo párrafo LISR, en relación con el Art. 9): el monto de la
 * PTU PAGADA en el mismo ejercicio se disminuye de la utilidad fiscal
 * estimada, por partes iguales, en los pagos provisionales de MAYO a
 * DICIEMBRE, de manera ACUMULATIVA — mayo 1/8, junio 2/8, …, diciembre 8/8.
 * Enero–abril no disminuyen nada. La disminución ocurre ANTES de amortizar
 * pérdidas fiscales de ejercicios anteriores (la propia fracc. II ordena
 * restar la pérdida a la utilidad fiscal ya disminuida con la PTU).
 *
 * Devuelve el monto acumulado disminuible en el mes (no capado a la utilidad —
 * el tope a cero de la base lo aplica el llamador, pues el excedente no genera
 * base negativa ni saldo alguno).
 *
 * Función pura (sin DB) para poder probar los octavos de forma aislada.
 */
export function ptuDisminuiblePM(params: {
  /** PTU total pagada en el ejercicio en curso (Art. 9, penúltimo párrafo). */
  ptuPagadaEjercicio: number | null;
  /** Mes del pago provisional (1–12). */
  month: number;
}): number {
  const { ptuPagadaEjercicio, month } = params;
  if (ptuPagadaEjercicio == null || ptuPagadaEjercicio <= 0) return 0;
  if (month < 5) return 0;
  const octavos = Math.min(month - 4, 8); // mayo=1 … diciembre=8
  return round2((ptuPagadaEjercicio * octavos) / 8);
}

/** Campos de una DECLARACION_ANUAL guardada que alimentan el coeficiente. */
export type AnualParaCoeficiente = {
  periodo: string;
  isrIngresos: number | null;
  isrDeducciones: number | null;
  isrBaseGravable: number | null;
  isrCoeficienteUtilidad: number | null;
};

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Coeficiente de utilidad derivado de UNA declaración anual guardada (Art. 14,
 * fracc. I LISR). La ley lo define como UTILIDAD FISCAL ÷ ingresos nominales —
 * ANTES de amortizar pérdidas fiscales de ejercicios anteriores (y sin restar
 * la PTU pagada, Art. 9 penúltimo párrafo) — así que dividir el RESULTADO
 * fiscal entre los ingresos lo subestimaría. Prioridad:
 *
 *  1. `isrCoeficienteUtilidad` guardado: tanto la anual calculada in-app
 *     (declaracion-anual.ts, utilidadOPerdida ÷ ingresos) como el acuse
 *     sincronizado (syntage/map.ts, utilidad fiscal ÷ ingresos nominales) lo
 *     persisten ya calculado sobre la utilidad PRE-pérdidas.
 *  2. Reconstrucción: utilidad fiscal = isrIngresos − isrDeducciones (la fila
 *     de la anual in-app guarda totalIngresos/totalDeducciones; su resta es la
 *     utilidad antes de pérdidas).
 *  3. Último recurso (filas legacy sin deducciones): isrBaseGravable ÷
 *     isrIngresos. En filas provenientes de acuse, isrBaseGravable ES la
 *     utilidad fiscal (correcto); en filas de la anual in-app es el resultado
 *     fiscal (post-pérdidas) y puede subestimar — sólo se usa a falta de todo
 *     lo demás, mejor un coeficiente conservador que ninguno.
 *
 * Un ejercicio con utilidad ≤ 0 NO produce coeficiente (→ null): el Art. 14
 * ordena usar el último ejercicio de 12 meses CON utilidad fiscal, hasta 5
 * ejercicios atrás (ver coeficienteAnualConHistorial). Se calcula hasta el
 * diezmilésimo (Art. 14, fracc. I, último párrafo).
 *
 * Función pura (sin DB) para poder probar la derivación de forma aislada.
 */
export function coeficienteDesdeAnual(row: AnualParaCoeficiente | null | undefined): number | null {
  if (!row) return null;
  if (row.isrCoeficienteUtilidad != null && row.isrCoeficienteUtilidad > 0) {
    return round4(row.isrCoeficienteUtilidad);
  }
  if (row.isrIngresos == null || row.isrIngresos <= 0) return null;
  if (row.isrDeducciones != null) {
    const utilidadFiscal = row.isrIngresos - row.isrDeducciones;
    return utilidadFiscal > 0 ? round4(utilidadFiscal / row.isrIngresos) : null;
  }
  if (row.isrBaseGravable != null && row.isrBaseGravable > 0) {
    return round4(row.isrBaseGravable / row.isrIngresos);
  }
  return null;
}

/**
 * Coeficiente de utilidad con la regla de arrastre del Art. 14, fracc. I,
 * segundo párrafo LISR: cuando en el último ejercicio de 12 meses no resulta
 * coeficiente (pérdida o datos insuficientes), se aplica el del ÚLTIMO
 * ejercicio de 12 meses por el que se tenga coeficiente, sin que ese ejercicio
 * sea anterior en más de CINCO años a aquél por el que se pagan provisionales.
 *
 * `rows` son las anuales guardadas disponibles (cualquier orden); se recorre
 * de `prevYear` hacia atrás hasta `prevYear − 4` (5 ejercicios candidatos) y
 * gana el primero que produzca coeficiente. Limitación del modelo de datos:
 * sólo consideramos anuales efectivamente capturadas/sincronizadas — un
 * ejercicio sin fila guardada simplemente no aporta coeficiente.
 */
export function coeficienteAnualConHistorial(
  rows: AnualParaCoeficiente[],
  prevYear: number
): { coeficiente: number; ejercicio: number } | null {
  for (let ejercicio = prevYear; ejercicio > prevYear - 5; ejercicio--) {
    // El periodo de las anuales varía de formato ("2024", "2024-13", …): se
    // empata por prefijo del año y, si hubiera varias filas, gana la de periodo
    // mayor (la más específica/reciente).
    const candidatas = rows
      .filter((r) => r.periodo.startsWith(String(ejercicio)))
      .sort((a, b) => (a.periodo < b.periodo ? 1 : -1));
    for (const row of candidatas) {
      const coeficiente = coeficienteDesdeAnual(row);
      if (coeficiente != null) return { coeficiente, ejercicio };
    }
  }
  return null;
}

const MESES_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function nombrePeriodo(periodo: string): string {
  const [y, m] = periodo.split("-").map(Number);
  return `${MESES_ES[m - 1]} de ${y}`;
}

/**
 * Avisos cuando la cadena de declaraciones guardadas está rota. El motor toma
 * el saldo a favor de IVA del mes anterior (Art. 6 LIVA — SÍ cruza ejercicios,
 * diciembre alimenta enero) y los pagos provisionales de ISR del ejercicio
 * (Art. 14 LISR — se reinician en enero) de las filas GUARDADAS
 * (CALCULATED/FILED/PAID): un mes con actividad sin declaración guardada hace
 * que esos arrastres valgan 0 en silencio y el periodo actual se sobrestime.
 *
 * Reglas:
 *  (a) El mes inmediato anterior tiene CFDI timbrados pero no declaración
 *      guardada → aviso de IVA + ISR (en enero, sólo IVA: el ISR del ejercicio
 *      empieza de cero, pero el saldo a favor de diciembre sí se arrastra).
 *  (b) Meses anteriores del MISMO ejercicio (antes del inmediato) con actividad
 *      y sin declaración → aviso de ISR listando los meses (acotado).
 *
 * Los meses previos a la primera factura de la empresa nunca aparecen en
 * `mesesConActividad`, así que no generan avisos por construcción.
 *
 * Función pura (sin DB) para poder probar la decisión de forma aislada.
 * Los periodos usan el formato "YYYY-MM".
 */
export function advertenciasCadenaDeclaraciones(params: {
  year: number;
  month: number;
  /** Periodos anteriores con al menos un CFDI timbrado (ene→mes−1 del ejercicio; dic anterior cuando month=1). */
  mesesConActividad: ReadonlySet<string>;
  /** Periodos con declaración guardada (IVA_MENSUAL o ISR_PROVISIONAL en CALCULATED/FILED/PAID). */
  mesesConDeclaracion: ReadonlySet<string>;
}): string[] {
  const { year, month, mesesConActividad, mesesConDeclaracion } = params;
  const advertencias: string[] = [];
  const pad = (m: number) => String(m).padStart(2, "0");
  const prevPeriodo = month === 1 ? `${year - 1}-12` : `${year}-${pad(month - 1)}`;

  // (a) Mes inmediato anterior: rompe el arrastre de IVA (y de ISR dentro del ejercicio).
  if (mesesConActividad.has(prevPeriodo) && !mesesConDeclaracion.has(prevPeriodo)) {
    if (month === 1) {
      // Enero: el saldo a favor de IVA de diciembre SÍ se arrastra (Art. 6
      // LIVA, el acreditamiento no se pierde al cambiar de ejercicio); el ISR
      // provisional del ejercicio empieza de cero, sin implicación.
      advertencias.push(
        `El mes anterior (${nombrePeriodo(prevPeriodo)}) tiene CFDI timbrados pero no cuenta con una declaración guardada (calculada o presentada). ` +
          `El saldo a favor de IVA de ese periodo —que sí se arrastra entre ejercicios (Art. 6 LIVA)— se está tomando como cero, ` +
          `por lo que el IVA a pagar de este periodo puede estar sobrestimado. Capture o calcule la declaración de ${nombrePeriodo(prevPeriodo)} antes de confiar en estas cifras.`
      );
    } else {
      advertencias.push(
        `El mes anterior (${nombrePeriodo(prevPeriodo)}) tiene CFDI timbrados pero no cuenta con una declaración guardada (calculada o presentada). ` +
          `El saldo a favor de IVA (Art. 6 LIVA) y los pagos provisionales de ISR acreditables (Art. 14 LISR) de ese periodo se están tomando como cero, ` +
          `por lo que el IVA y el ISR a pagar de este periodo pueden estar sobrestimados. Capture o calcule la declaración de ${nombrePeriodo(prevPeriodo)} antes de confiar en estas cifras.`
      );
    }
  }

  // (b) ISR acumulativo (Art. 14): cualquier mes anterior del ejercicio sin
  // declaración guardada subestima "pagos provisionales efectuados con
  // anterioridad". El mes inmediato ya quedó cubierto por (a).
  if (month > 2) {
    const faltantes: string[] = [];
    for (let m = 1; m <= month - 2; m++) {
      const p = `${year}-${pad(m)}`;
      if (mesesConActividad.has(p) && !mesesConDeclaracion.has(p)) faltantes.push(p);
    }
    if (faltantes.length > 0) {
      const MAX_LISTA = 5;
      const lista =
        faltantes.slice(0, MAX_LISTA).map(nombrePeriodo).join(", ") +
        (faltantes.length > MAX_LISTA ? ` y ${faltantes.length - MAX_LISTA} mes(es) más` : "");
      advertencias.push(
        `Hay meses del ejercicio con CFDI timbrados y sin declaración guardada: ${lista}. ` +
          `Los pagos provisionales de ISR efectuados con anterioridad (Art. 14 LISR) pueden estar subestimados y, en consecuencia, el ISR a pagar de este periodo sobrestimado.`
      );
    }
  }

  return advertencias;
}

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
    annualDecls,
    perdidasRecords,
  ] = await Promise.all([
    prisma.invoice.findMany({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: from, lt: to } },
      include: invoiceInclude,
    }).then((rows) => rows.map((inv) => ({ ...inv, subtotal: Number(inv.subtotal), totalImpuestos: Number(inv.totalImpuestos), taxes: inv.taxes.map((t) => ({ ...t, importe: Number(t.importe), base: t.base === null ? null : Number(t.base) })) }))),
    prisma.invoice.findMany({
      where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: from, lt: to }, ...efosWhere },
      include: invoiceInclude,
    }).then((rows) => rows.map((inv) => ({ ...inv, subtotal: Number(inv.subtotal), totalImpuestos: Number(inv.totalImpuestos), taxes: inv.taxes.map((t) => ({ ...t, importe: Number(t.importe), base: t.base === null ? null : Number(t.base) })) }))),
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
    }).then((rows) => rows.map((d) => ({ ...d, isrPagar: d.isrPagar === null ? null : Number(d.isrPagar) }))),
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
      select: { coeficienteUtilidad: true, coeficienteAnio: true, perdidaFiscalPendiente: true, perdidaFiscalAnio: true, regimenFiscal: true, rfc: true, plataformaActividad: true },
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
    }).then((rows) => rows.map((l) => ({ ...l, impPagado: l.impPagado === null ? null : Number(l.impPagado), ivaTrasladado: l.ivaTrasladado === null ? null : Number(l.ivaTrasladado) }))),
    // Coeficiente autoritativo: declaraciones anuales guardadas de los últimos
    // 5 ejercicios (Art. 14, fracc. I LISR — si el último ejercicio no arroja
    // coeficiente, se usa el del último ejercicio CON utilidad, hasta 5 años
    // atrás). El periodo de las anuales varía de formato, así que se busca por
    // prefijo del año.
    prisma.taxDeclaration.findMany({
      where: {
        companyId,
        tipo: "DECLARACION_ANUAL",
        OR: Array.from({ length: 5 }, (_, i) => ({ periodo: { startsWith: String(prevYear - i) } })),
        status: { in: ["CALCULATED", "FILED", "PAID"] },
      },
      orderBy: { periodo: "desc" },
      select: { periodo: true, isrIngresos: true, isrDeducciones: true, isrBaseGravable: true, isrCoeficienteUtilidad: true, isrPerdidaPendiente: true },
    }).then((rows) => rows.map((d) => ({ ...d, isrIngresos: d.isrIngresos === null ? null : Number(d.isrIngresos), isrDeducciones: d.isrDeducciones === null ? null : Number(d.isrDeducciones), isrBaseGravable: d.isrBaseGravable === null ? null : Number(d.isrBaseGravable), isrCoeficienteUtilidad: d.isrCoeficienteUtilidad === null ? null : Number(d.isrCoeficienteUtilidad), isrPerdidaPendiente: d.isrPerdidaPendiente === null ? null : Number(d.isrPerdidaPendiente) }))),
    // Pérdidas fiscales pendientes (Art. 57) — sólo las consume el provisional PF
    // de actividad empresarial (Art. 106); el ledger lo cierra la anual, aquí es
    // sólo lectura.
    prisma.perdidaFiscal.findMany({ where: { companyId } }).then((rows) => rows.map((p) => ({ ...p, montoOriginal: Number(p.montoOriginal), saldoActualizado: Number(p.saldoActualizado) }))),
  ]);

  // Notas de crédito ("E") en los agregados anuales: el agregado positivo las
  // incluye (+), así que el neto es total − 2·E.
  const [prevYearIngresosE, prevYearEgresosE, acumuladosE] = await Promise.all([
    prisma.invoice.aggregate({
      where: { companyId, tipo: "INGRESO", tipoSat: "E", status: "STAMPED", fecha: { gte: prevYearFrom, lte: prevYearTo } },
      _sum: { subtotal: true },
    }),
    prisma.invoice.aggregate({
      where: { companyId, tipo: "EGRESO", tipoSat: "E", status: "STAMPED", fecha: { gte: prevYearFrom, lte: prevYearTo }, ...efosWhere },
      _sum: { subtotal: true },
    }),
    prisma.invoice.aggregate({
      where: { companyId, tipo: "INGRESO", tipoSat: "E", status: "STAMPED", fecha: { gte: yearFrom, lt: to } },
      _sum: { subtotal: true },
    }),
  ]);

  // Resolve the parent PPD invoices these REP payments settle: the parent's
  // tipo decides direction (INGRESO → trasladado, EGRESO → acreditable) and its
  // IVA/total is the proration base for legacy 1.0 complementos.
  const repParentUuids = variantesUuid(repCobrosDelMes.map((r) => r.parentUuid));
  const repParents = repParentUuids.length
    ? await prisma.invoice.findMany({
        where: { companyId, uuid: { in: repParentUuids }, metodoPago: "PPD", status: "STAMPED" },
        select: { uuid: true, tipo: true, tipoSat: true, total: true, totalImpuestos: true, taxes: true, ivaNoAcreditable: true, ivaNoCausado: true, customer: { select: { rfc: true } } },
      }).then((rows) => rows.map((p) => ({ ...p, total: Number(p.total), totalImpuestos: Number(p.totalImpuestos), taxes: p.taxes.map((t) => ({ ...t, importe: Number(t.importe) })) })))
    : [];
  const repParentByUuid = new Map(repParents.map((p) => [normalizarUuid(p.uuid!), p]));
  const esEfosBloqueado = (rfc?: string | null) =>
    efosBloqueados.size > 0 && !!rfc && efosBloqueados.has(rfc.toUpperCase().trim());

  let ivaTrasladadoPPD = 0;
  let ivaAcreditablePPD = 0;
  let ivaRetenidoProvPPD = 0;
  let isrRetenidoProvPPD = 0;
  for (const link of repCobrosDelMes) {
    const parent = repParentByUuid.get(normalizarUuid(link.parentUuid));
    if (!parent) continue; // REP references a non-PPD or unknown invoice — skip
    const signo = signoTipoSat(parent.tipoSat);
    const iva = signo * repIvaTrasladado(link, parent);
    if (parent.tipo === "INGRESO" && !parent.ivaNoCausado) ivaTrasladadoPPD += iva;
    else if (parent.tipo === "EGRESO") {
      // La retención se hace al PAGAR (Art. 1-A): cada REP retiene su parte.
      const retenido = signo * repIvaRetenidoDe(link, parent);
      ivaRetenidoProvPPD += retenido;
      isrRetenidoProvPPD += signo * repIsrRetenidoDe(link, parent);
      // EGRESO de proveedor 69-B definitivo → IVA no acreditable (Art. 69-B).
      // Igual si el contador lo excluyó del acreditamiento (p. ej. no pagado).
      // Lo retenido NO es acreditable este mes (Art. 5-IV): se descuenta.
      if (!esEfosBloqueado(parent.customer?.rfc) && !parent.ivaNoAcreditable) ivaAcreditablePPD += Math.max(0, iva - retenido);
    }
  }

  // ── IVA (flujo de efectivo) ──────────────────────────────────────────────
  const ivaTrasladadoPUE = facturasEmitidas
    .filter((inv) => inv.metodoPago === "PUE" && !inv.ivaNoCausado)
    .reduce((s, inv) => s + signoTipoSat(inv.tipoSat) * ivaTrasladado(inv), 0);
  const ivaTrasladadoTotal = ivaTrasladadoPUE + ivaTrasladadoPPD;

  const ivaTrasladadoDevengado = facturasEmitidas.reduce((s, inv) => s + signoTipoSat(inv.tipoSat) * ivaTrasladado(inv), 0);
  const ivaRetenidoPorClientes = facturasEmitidas.reduce(
    (sum, inv) => sum + inv.taxes.filter((t) => t.tipo === "IVA" && t.retencion).reduce((s, t) => s + t.importe, 0),
    0
  );
  // IVA que NOSOTROS retuvimos a proveedores en el mes, en FLUJO (Art. 1-A: la
  // retención nace al pagar → PUE al emitirse, PPD con cada REP). Es un pasivo
  // a ENTERAR al SAT junto con esta declaración; no reduce nuestro IVA a cargo.
  const ivaRetenidoProvPUE = facturasEgresos
    .filter((inv) => inv.metodoPago === "PUE")
    .reduce((s, inv) => s + signoTipoSat(inv.tipoSat) * ivaRetenidoDe(inv), 0);
  const ivaRetenidoAProveedores = ivaRetenidoProvPUE + ivaRetenidoProvPPD;
  // ISR retenido a proveedores PF (mismo criterio de flujo): también se entera.
  const isrRetenidoAProveedores =
    facturasEgresos
      .filter((inv) => inv.metodoPago === "PUE")
      .reduce((s, inv) => s + signoTipoSat(inv.tipoSat) * isrRetenidoDe(inv), 0) + isrRetenidoProvPPD;

  // Acreditable del mes NETO de lo retenido (Art. 5-IV LIVA): la parte retenida
  // sólo se acredita en el mes siguiente al de su entero.
  const ivaAcreditablePUE = facturasEgresos
    .filter((inv) => inv.metodoPago === "PUE" && !inv.ivaNoAcreditable)
    .reduce((s, inv) => s + signoTipoSat(inv.tipoSat) * ivaAcreditableNetoDe(inv), 0);
  // Lo retenido el MES ANTERIOR (enterado con aquella declaración) se acredita
  // en ésta. Se calcula con el mismo criterio de flujo para el periodo previo.
  const prevFrom = new Date(year, month - 2, 1);
  const ivaRetenidoMesAnteriorAcreditable = await ivaRetenidoAProveedoresEnPeriodo(companyId, prevFrom, from);
  const ivaAcreditableBruto = ivaAcreditablePUE + ivaAcreditablePPD + ivaRetenidoMesAnteriorAcreditable;
  const ivaAcreditableDevengado = facturasEgresos.reduce((s, inv) => s + signoTipoSat(inv.tipoSat) * ivaTrasladado(inv), 0);

  // Proporción de acreditamiento (Art. 5-V LIVA): con actos exentos en el mes,
  // el IVA de los gastos sólo procede en gravados/(gravados+exentos). v1 trata
  // todos los gastos como indistintos (sin destino etiquetado por gasto). Sin
  // exentos la proporción es 1 y el comportamiento no cambia.
  const actos = calcularActosDelPeriodo(facturasEmitidas);
  const ivaAcreditable = round2(ivaAcreditableBruto * actos.proporcion);

  const saldoFavorAnterior = Number(prevDeclaracion?.ivaSaldoFavor ?? 0);
  const ivaNeto = ivaTrasladadoTotal - ivaAcreditable - ivaRetenidoPorClientes - saldoFavorAnterior;
  const ivaPagar = Math.max(0, round2(ivaNeto));
  const ivaSaldoAFavor = ivaNeto < 0 ? round2(-ivaNeto) : 0;

  // ── ISR provisional — régimen-aware ──────────────────────────────────────
  const ingresosDelMes = round2(facturasEmitidas.reduce((s, inv) => s + signoTipoSat(inv.tipoSat) * inv.subtotal, 0));
  const gastosDelMes = round2(facturasEgresos.reduce((s, inv) => s + signoTipoSat(inv.tipoSat) * inv.subtotal, 0));
  const ingresosAcumulados =
    Number(ingresosAcumuladosAgg._sum.subtotal ?? 0) - 2 * Number(acumuladosE._sum.subtotal ?? 0);
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
      retenidoAProveedoresEnterar: 0, // se rellena al final (flujo, todos los regímenes)
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
    const saldoFavorIsrAnterior = month === 1 ? 0 : round2(Number(prevIsrDeclaracion?.isrSaldoFavor ?? 0));
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
      retenidoAProveedoresEnterar: 0, // se rellena al final (flujo, todos los regímenes)
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
    // Predial pagado del mes (Art. 115: deducible ADEMÁS de la ciega). Se lee
    // del BANCO y no de CFDIs porque el predial se paga a tesorerías
    // municipales que rara vez timbran: el cargo bancario ES la erogación.
    // Tomarlo de una sola fuente evita además contarlo dos veces cuando sí
    // existe CFDI y quedó conciliado con su movimiento.
    const cargosDelMes = await prisma.bankTransaction.findMany({
      where: { companyId, fecha: { gte: from, lt: to }, monto: { lt: 0 } },
      select: { descripcion: true, monto: true },
    });
    const predialPagadoMes = round2(
      cargosDelMes
        .filter((t) => esErogacionPredial(t.descripcion))
        .reduce((s, t) => s + Math.abs(Number(t.monto)), 0)
    );
    const r = calcularIsrArrendamientoMensual({
      ejercicio: year,
      ingresosCobradosMes: mes.ingresosCobrados,
      retencionesMes: mes.isrRetenidoCobrado,
      predialPagadoMes,
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
      retenidoAProveedoresEnterar: 0, // se rellena al final (flujo, todos los regímenes)
      saldoFavorAnterior: 0,
      saldoAFavor: 0,
      tarifaVerificada: r ? r.tarifaVerificada : false,
      predialPagado: r ? r.predialPagado : predialPagadoMes,
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
      retenidoAProveedoresEnterar: 0, // se rellena al final (flujo, todos los regímenes)
      // se auto-corrige en el cálculo acumulado — no necesita arrastre explícito.
      saldoFavorAnterior: 0,
      saldoAFavor: 0,
      tarifaVerificada: r ? r.tarifaVerificada : false,
    };
  } else {
    // Persona MORAL general / RESICO PM / otros: Art. 14 (coeficiente × 30%
    // sobre ingresos nominales acumulados). Sólo personas morales llegan aquí —
    // cualquier persona física se resuelve arriba con tarifa/tasa (sin coeficiente).
    const prevIngresosTotal =
      Number(prevYearIngresos._sum.subtotal ?? 0) - 2 * Number(prevYearIngresosE._sum.subtotal ?? 0);
    const prevGastosTotal =
      Number(prevYearEgresos._sum.subtotal ?? 0) - 2 * Number(prevYearEgresosE._sum.subtotal ?? 0);
    const prevUtilidad = Math.max(0, prevIngresosTotal - prevGastosTotal);
    const coeficienteCalculado = prevIngresosTotal > 0 ? prevUtilidad / prevIngresosTotal : null;

    // Coeficiente tomado de las declaraciones anuales guardadas — la fuente
    // autoritativa por ley (Art. 14, fracc. I LISR: UTILIDAD FISCAL ÷ ingresos
    // nominales, ANTES de amortizar pérdidas; dividir el resultado fiscal
    // subestimaría el provisional). Si el ejercicio inmediato anterior no
    // arroja coeficiente (pérdida), se usa el del último ejercicio con
    // utilidad, hasta 5 años atrás (fracc. I, segundo párrafo).
    const coeficienteAnual = coeficienteAnualConHistorial(annualDecls, prevYear)?.coeficiente ?? null;

    // Coeficiente que YA se aplicó en un pago provisional capturado (de un acuse
    // del SAT). Corrobora el valor real usado; el más reciente disponible.
    const [coefProvRow, ptuNominaAgg] = await Promise.all([
      prisma.taxDeclaration.findFirst({
        where: { companyId, tipo: "ISR_PROVISIONAL", isrCoeficienteUtilidad: { not: null } },
        orderBy: { periodo: "desc" },
        select: { isrCoeficienteUtilidad: true },
      }),
      // PTU pagada en el EJERCICIO EN CURSO (Art. 14, fracc. II, segundo párrafo
      // LISR): suma de PayrollItem.ptu de las corridas de nómina del año con
      // fecha de pago hasta el cierre del periodo — la misma fuente que usa la
      // declaración anual (las corridas tipo PTU escriben la percepción SAT 003
      // en la columna ptu). Sólo la PTU ya PAGADA al cierre del mes se
      // disminuye; la PTU pagada fuera del módulo de nómina no se detecta.
      prisma.payrollItem.aggregate({
        where: {
          payrollRun: {
            companyId,
            status: { in: ["CALCULATED", "STAMPED", "PAID"] },
            fechaPago: { gte: yearFrom, lt: to },
          },
        },
        _sum: { ptu: true },
      }),
    ]);
    const coeficienteDeclarado = coefProvRow?.isrCoeficienteUtilidad != null ? Number(coefProvRow.isrCoeficienteUtilidad) : null;
    const ptuPagadaEjercicio = round2(Number(ptuNominaAgg._sum.ptu ?? 0));

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
      coeficiente = Number(company.coeficienteUtilidad);
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

    // Pérdidas fiscales de ejercicios anteriores pendientes de aplicar (Art. 14):
    // el remanente ACTUALIZADO se amortiza contra la utilidad fiscal estimada
    // antes de aplicar la tasa del 30%. Prioridad (igual que el coeficiente): el
    // valor manual de la empresa gana; si no hay, se usa el remanente extraído de
    // la declaración anual del ejercicio anterior (isrPerdidaPendiente), que
    // corresponde justo al año de los provisionales en curso.
    // El remanente de pérdidas viene EXCLUSIVAMENTE de la anual del ejercicio
    // inmediato anterior (es el saldo actualizado que aplica a este año) — no
    // de las anuales más viejas que el lookback del coeficiente sí considera.
    const annualDeclPrev = annualDecls.find((r) => r.periodo.startsWith(String(prevYear))) ?? null;
    const usaPerdidaManual = company?.perdidaFiscalPendiente != null;
    const perdidaFiscalPendiente = usaPerdidaManual
      ? Number(company!.perdidaFiscalPendiente)
      : (annualDeclPrev?.isrPerdidaPendiente ?? null);
    const perdidaFiscalAnio = usaPerdidaManual
      ? (company?.perdidaFiscalAnio ?? null)
      : (annualDeclPrev?.isrPerdidaPendiente != null ? prevYear : null);

    let utilidadFiscal: number | null = null;
    let baseGravable: number | null = null;
    let ptuDisminuida: number | null = null;
    let perdidaFiscalAplicada: number | null = null;
    let isrDelEjercicio: number | null = null;
    let isrPagar: number | null = null;
    if (coeficiente !== null && coeficiente > 0) {
      utilidadFiscal = round2(ingresosAcumulados * coeficiente);
      // PTU pagada en el ejercicio disminuida en octavos acumulados de mayo a
      // diciembre (Art. 14, fracc. II, segundo párrafo LISR) — ANTES de
      // amortizar pérdidas fiscales de ejercicios anteriores. El excedente no
      // genera base negativa: la utilidad tras PTU tiene piso en cero.
      const ptuOctavos = ptuDisminuiblePM({ ptuPagadaEjercicio, month });
      ptuDisminuida = round2(Math.min(ptuOctavos, Math.max(0, utilidadFiscal)));
      const utilidadTrasPtu = Math.max(0, round2(utilidadFiscal - ptuOctavos));
      const { perdidaAplicada, baseGravable: base } = aplicarPerdidaFiscalPM({
        utilidadFiscal: utilidadTrasPtu,
        perdidaPendiente: perdidaFiscalPendiente,
        perdidaAnio: perdidaFiscalAnio,
        year,
      });
      perdidaFiscalAplicada = perdidaAplicada;
      baseGravable = base;
      isrDelEjercicio = round2(baseGravable * ISR_TASA_PM);
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
      baseGravable,
      tasa: ISR_TASA_PM,
      utilidadFiscal,
      perdidaFiscalPendiente,
      perdidaFiscalAplicada,
      ptuPagadaEjercicio,
      ptuDisminuida,
      isrDelEjercicio,
      isrPagar,
      retencionesAcreditadas: 0, // PM Art. 14 no acredita retención 10% PF
      retenidoAProveedoresEnterar: 0, // se rellena al final (flujo, todos los regímenes)
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
      subtotalExcluido: round2(Number(aggExcl._sum.subtotal ?? 0)),
      ivaAcreditableExcluido: round2(Number(ivaExcl._sum.importe ?? 0)),
    };
  }

  // ── Avisos de cadena de arrastre rota ──────────────────────────────────────
  // saldoFavorAnterior (IVA, Art. 6 LIVA) e isrPagadoAnterior (Art. 14 LISR)
  // provienen de declaraciones GUARDADAS: si un mes con actividad nunca se
  // guardó, valen 0 en silencio y este periodo se sobrestima. Meses candidatos:
  // ene→mes−1 del ejercicio; en enero, sólo diciembre anterior (la cadena de
  // IVA sí cruza ejercicios; el ISR del ejercicio empieza de cero).
  const periodosCandidatos =
    month === 1
      ? [prevPeriodo]
      : Array.from({ length: month - 1 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const actividadPorPeriodo = await Promise.all(
    periodosCandidatos.map(async (p) => {
      const [py, pm] = p.split("-").map(Number);
      const alguna = await prisma.invoice.findFirst({
        where: { companyId, status: "STAMPED", fecha: { gte: new Date(py, pm - 1, 1), lt: new Date(py, pm, 1) } },
        select: { id: true },
      });
      return alguna ? p : null;
    })
  );
  const mesesConActividad = new Set(actividadPorPeriodo.filter((p): p is string => p !== null));
  // Declaraciones guardadas: las del ejercicio (IVA_MENSUAL/ISR_PROVISIONAL ya
  // consultadas arriba) más el mes anterior cuando cruza de ejercicio (enero).
  const mesesConDeclaracion = new Set(declaracionesPrevias.map((d) => d.periodo));
  if (prevDeclaracion || prevIsrDeclaracion) mesesConDeclaracion.add(prevPeriodo);
  const advertencias = advertenciasCadenaDeclaraciones({ year, month, mesesConActividad, mesesConDeclaracion });

  isr.retenidoAProveedoresEnterar = round2(Math.max(0, isrRetenidoAProveedores));

  return {
    periodo,
    month,
    year,
    efos,
    advertencias,
    iva: {
      trasladado: round2(ivaTrasladadoTotal),
      retenidoPorClientes: round2(ivaRetenidoPorClientes),
      retenidoAProveedores: round2(ivaRetenidoAProveedores),
      retenidoMesAnteriorAcreditable: round2(ivaRetenidoMesAnteriorAcreditable),
      totalConRetenciones: round2(ivaPagar + Math.max(0, ivaRetenidoAProveedores)),
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
