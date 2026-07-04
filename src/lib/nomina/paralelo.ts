// ─────────────────────────────────────────────────────────────────────────────
// Nómina en paralelo — recalcular el histórico timbrado con NUESTRO motor.
//
// La empresa ya tiene quincenas timbradas por su proveedor actual (importadas
// del SAT: PayrollRun.origen = "SAT"). Este módulo toma cada recibo timbrado,
// recalcula la parte DETERMINISTA del cálculo — ISR retenido (tarifa Art. 96 +
// subsidio al empleo vigentes a la fecha de pago) y la cuota obrera del IMSS
// (desde el SBC del propio recibo) — y muestra la diferencia contra lo que su
// proveedor timbró. Coincidir al centavo construye confianza matemática; una
// diferencia significa tablas desactualizadas del proveedor o un bug nuestro.
//
// PRINCIPIO DE DISEÑO — comparar motores sobre entradas IDÉNTICAS:
//   - El lado BRUTO timbrado se toma como dado (percepciones, partición
//     gravado/exento, días, SBC). NO intentamos reproducirlo: las incidencias
//     y faltas son invisibles para nosotros y sólo producirían diffs de ruido.
//   - Sólo se recalcula la matemática fiscal determinista, con las tablas
//     VIGENTES en el ejercicio de la fecha de pago (nunca las de hoy).
//   - Donde falten insumos o tablas verificadas del ejercicio, el recibo se
//     marca "no comparable" — jamás se calcula con tablas de otro año.
//   - v1 compara únicamente corridas ORDINARIAS (finiquitos, PTU, aguinaldo y
//     extraordinarias tienen mecánica de ISR distinta).
//
// SÓLO LECTURA: nada de este módulo escribe en datos de nómina. El desglose
// gravado/exento que el importador no conserva se re-parsea del rawXml del
// CFDI vinculado (Invoice.uuid ↔ PayrollItem.cfdiUuid) al momento del análisis.
//
// Piezas, separadas a propósito (mismo patrón que historia-import):
//   1. parseEntradaParalelo(rawXml)   — PURA. Extrae del CFDI los insumos.
//   2. compararRecibo(entrada)        — PURA. El corazón: recalcula y compara.
//   3. compararCorrida(runId)         — DB, acotada. Una corrida completa.
//   4. resumenParalelo(companyId)     — DB, acotada. Las últimas N corridas.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { parseComplementoNomina } from "./roster-import";
import { calcularIsrRetenido } from "./isr";
import { calcularImss } from "./imss";
import { umaDiariaDelEjercicio } from "./constants";
import { subsidioEmpleo } from "../fiscal/tarifas";

// Tolerancia por concepto: las convenciones de redondeo entre motores difieren
// legítimamente (mensualización, orden de redondeos) — hasta $1.00 es coincidencia.
export const TOLERANCIA_PESOS = 1.0;

// Máximo de recibos por corrida y de corridas por resumen (cálculo on-demand,
// sin persistencia — el costo debe estar acotado).
const MAX_RECIBOS_POR_CORRIDA = 400;
export const MAX_CORRIDAS_RESUMEN = 12;

// Percepciones cuyo ISR NO se retiene con la tarifa mensual plana del Art. 96
// (Art. 174 RLISR para gratificaciones/PTU/prima vacacional; Arts. 95-96 LISR
// para separación/jubilación). Si el recibo trae monto GRAVADO en alguna, la
// mensualización simple produciría un diff falso → no comparable.
const PERCEPCIONES_TRATAMIENTO_ESPECIAL: Record<string, string> = {
  "002": "aguinaldo",
  "003": "PTU",
  "021": "prima vacacional",
  "022": "pagos por separación",
  "023": "pagos por separación (jubilación)",
  "025": "indemnizaciones",
  "039": "jubilaciones (exhibición única)",
  "044": "jubilaciones (parcialidades)",
};

// Fecha de entrada en vigor del decreto de subsidio al empleo vigente
// (DOF 01-may-2024). Antes regía la tabla decreciente de 2013, que NO está
// modelada — los recibos previos con subsidio en juego no son comparables.
const DECRETO_SUBSIDIO_2024 = "2024-05-01";

const r2 = (n: number) => Math.round(n * 100) / 100;

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface ConceptoComparado {
  /** Lo que calcula nuestro motor con las tablas vigentes a la fecha de pago. */
  nuestro: number;
  /** Lo que el proveedor actual timbró en el CFDI. */
  timbrado: number;
  /** nuestro − timbrado (positivo = nosotros calculamos más). */
  delta: number;
}

export type VeredictoComparacion = "coincide" | "difiere" | "no-comparable";

export interface EntradaComparacion {
  /** FechaPago del recibo (ISO date) — determina el ejercicio y las tablas. */
  fechaPago: string;
  /** Código SAT de periodicidad ("04" quincenal, "05" mensual, ...). */
  periodicidadPago: string | null;
  /** NumDiasPagados del recibo. */
  diasPagados: number | null;
  /**
   * Días calendario del periodo (FechaInicialPago→FechaFinalPago, inclusive).
   * Convención alternativa de días para IMSS: muchos proveedores cotizan los
   * días naturales del periodo (16 en una quincena de 16 días) aunque el
   * recibo diga NumDiasPagados=15.
   */
  diasPeriodo?: number | null;
  /** SalarioBaseCotApor del recibo (diario). */
  sbcDiario: number | null;
  /** Suma de ImporteGravado de todas las percepciones — la base del ISR. */
  totalGravado: number;
  /** Suma de ImporteExento (informativo; no entra a la base). */
  totalExento: number;
  /** Gravado por TipoPercepcion, para detectar tratamientos especiales. */
  gravadoPorCodigo?: Record<string, number>;
  /** TipoNomina del complemento: "O" ordinaria | "E" extraordinaria. */
  tipoNomina: string | null;
  /** True si el recibo trae separación/indemnización (finiquito). */
  esFiniquito: boolean;
  /** Lo timbrado por el proveedor — el otro lado de la comparación. */
  timbrado: {
    isr: number;
    imssObrero: number;
    /** OtroPago 002 (subsidio ENTREGADO en efectivo al trabajador). */
    subsidioEntregado: number;
  };
}

export interface ComparacionRecibo {
  comparable: boolean;
  motivoNoComparable?: string;
  /** Ejercicio de las tablas usadas (año de la fecha de pago). */
  ejercicio?: number;
  isr?: ConceptoComparado;
  imssObrero?: ConceptoComparado;
  subsidio?: ConceptoComparado;
  /**
   * Convención de días con la que coincidió el IMSS: "diasPagados" o
   * "diasPeriodo" (días naturales del periodo). Sólo informativo.
   */
  imssConvencionDias?: "diasPagados" | "diasPeriodo";
  veredicto: VeredictoComparacion;
}

// ── 1. Parser PURO de los insumos de comparación desde el CFDI ───────────────

function num(v: string | null | undefined): number {
  const n = v != null && v !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Extrae de un CFDI de nómina timbrado los insumos de la comparación:
 * la partición gravado/exento por percepción (que el importador histórico no
 * conserva), SBC, días, periodicidad y lo timbrado (ISR, IMSS obrero, subsidio
 * entregado). Devuelve null si el XML no es un recibo de nómina legible o no
 * trae fecha de pago. NO lanza.
 */
export function parseEntradaParalelo(
  rawXml: string | null | undefined
): EntradaComparacion | null {
  const comp = parseComplementoNomina(rawXml);
  if (!comp || !rawXml || !comp.fechaPago) return null;

  const nominaAttrs = /<(?:[a-zA-Z0-9]+:)?Nomina\b([^>]*)>/.exec(rawXml)?.[1] ?? "";
  const nAttr = (name: string) =>
    new RegExp(`\\b${name}="([^"]*)"`).exec(nominaAttrs)?.[1] ?? null;

  // Percepciones: gravado por código (la base del ISR es la suma de gravados).
  const gravadoPorCodigo: Record<string, number> = {};
  let totalGravado = 0;
  let totalExento = 0;
  const percRe = /<(?:[a-zA-Z0-9]+:)?Percepcion\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = percRe.exec(rawXml)) !== null) {
    const attrs = m[1];
    const get = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
    const tipo = get("TipoPercepcion");
    if (!tipo) continue;
    const gravado = num(get("ImporteGravado"));
    const exento = num(get("ImporteExento"));
    gravadoPorCodigo[tipo] = r2((gravadoPorCodigo[tipo] ?? 0) + gravado);
    totalGravado = r2(totalGravado + gravado);
    totalExento = r2(totalExento + exento);
  }

  // Deducciones timbradas: 002 ISR, 001 IMSS (cuota obrera).
  let isrTimbrado = 0;
  let imssTimbrado = 0;
  const dedRe = /<(?:[a-zA-Z0-9]+:)?Deduccion\b([^>]*?)\/?>/g;
  while ((m = dedRe.exec(rawXml)) !== null) {
    const attrs = m[1];
    const get = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
    const tipo = get("TipoDeduccion");
    if (tipo === "002") isrTimbrado = r2(isrTimbrado + num(get("Importe")));
    else if (tipo === "001") imssTimbrado = r2(imssTimbrado + num(get("Importe")));
  }

  // Otros pagos: 002 = subsidio para el empleo ENTREGADO (efectivo).
  let subsidioEntregado = 0;
  const otroRe = /<(?:[a-zA-Z0-9]+:)?OtroPago\b([^>]*?)\/?>/g;
  while ((m = otroRe.exec(rawXml)) !== null) {
    const attrs = m[1];
    const get = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
    if (get("TipoOtroPago") === "002") subsidioEntregado = r2(subsidioEntregado + num(get("Importe")));
  }

  // Días naturales del periodo (convención alternativa de días para IMSS).
  let diasPeriodo: number | null = null;
  const fIni = nAttr("FechaInicialPago");
  const fFin = nAttr("FechaFinalPago");
  if (fIni && fFin) {
    const ini = new Date(`${fIni}T00:00:00Z`).getTime();
    const fin = new Date(`${fFin}T00:00:00Z`).getTime();
    if (Number.isFinite(ini) && Number.isFinite(fin) && fin >= ini) {
      diasPeriodo = Math.round((fin - ini) / 86400000) + 1;
    }
  }

  return {
    fechaPago: comp.fechaPago,
    periodicidadPago: comp.periodicidadPago,
    diasPagados: nAttr("NumDiasPagados") != null ? num(nAttr("NumDiasPagados")) : null,
    diasPeriodo,
    sbcDiario: comp.sbc,
    totalGravado,
    totalExento,
    gravadoPorCodigo,
    tipoNomina: comp.tipoNomina,
    esFiniquito: comp.esFiniquito,
    timbrado: { isr: isrTimbrado, imssObrero: imssTimbrado, subsidioEntregado },
  };
}

// ── 2. Comparador PURO de un recibo ──────────────────────────────────────────

function noComparable(motivo: string, ejercicio?: number): ComparacionRecibo {
  return { comparable: false, motivoNoComparable: motivo, ejercicio, veredicto: "no-comparable" };
}

/**
 * Recalcula ISR retenido, IMSS obrero y subsidio entregado de un recibo con
 * NUESTRO motor (tablas vigentes a la fecha de pago) y los compara contra lo
 * timbrado. Tolerancia ±$1.00 por concepto (convenciones de redondeo difieren
 * legítimamente). Donde falte un insumo o una tabla verificada del ejercicio,
 * devuelve "no-comparable" con el motivo — nunca calcula con tablas de otro año.
 */
export function compararRecibo(entrada: EntradaComparacion): ComparacionRecibo {
  // Fecha de pago → ejercicio/mes (determinan las tablas).
  const fecha = new Date(`${entrada.fechaPago.slice(0, 10)}T00:00:00Z`);
  if (!entrada.fechaPago || isNaN(fecha.getTime())) {
    return noComparable("El recibo no trae fecha de pago legible");
  }
  const ejercicio = fecha.getUTCFullYear();
  const mes = fecha.getUTCMonth() + 1;
  const fechaIso = entrada.fechaPago.slice(0, 10);

  // v1: sólo nómina ordinaria — finiquitos/extraordinarias (aguinaldo, PTU)
  // tienen mecánica de ISR distinta.
  if (entrada.esFiniquito || entrada.tipoNomina === "E") {
    return noComparable("Recibo extraordinario o de finiquito — sólo se comparan nóminas ordinarias", ejercicio);
  }

  // Percepciones gravadas con tratamiento especial de ISR dentro de una
  // ordinaria (p. ej. prima vacacional gravada): la tarifa plana no aplica.
  const especiales = Object.entries(entrada.gravadoPorCodigo ?? {})
    .filter(([tipo, gravado]) => PERCEPCIONES_TRATAMIENTO_ESPECIAL[tipo] != null && gravado > 0.01)
    .map(([tipo]) => PERCEPCIONES_TRATAMIENTO_ESPECIAL[tipo]);
  if (especiales.length > 0) {
    return noComparable(
      `Percepciones gravadas con tratamiento especial de ISR (${[...new Set(especiales)].join(", ")})`,
      ejercicio
    );
  }

  if (entrada.totalGravado <= 0) return noComparable("El recibo no trae base gravable", ejercicio);
  if (!entrada.periodicidadPago) return noComparable("El recibo no trae periodicidad de pago", ejercicio);
  if (entrada.sbcDiario == null || entrada.sbcDiario <= 0) {
    return noComparable("El recibo no trae salario base de cotización (SBC)", ejercicio);
  }
  if (entrada.diasPagados == null || entrada.diasPagados <= 0) {
    return noComparable("El recibo no trae días pagados", ejercicio);
  }

  // ── ISR con las tablas del ejercicio de la fecha de pago ──
  const isrCalc = calcularIsrRetenido({
    baseGravable: entrada.totalGravado,
    periodicidadPago: entrada.periodicidadPago,
    ejercicio,
    mes,
  });
  // Tabla vencida, sin cotejar o inexistente para el ejercicio (p. ej. 2023 y
  // anteriores): no comparar con tablas de otro año.
  if (!isrCalc.tarifaVerificada) {
    return noComparable(`Sin tablas ISR verificadas para el ejercicio ${ejercicio}`, ejercicio);
  }

  // Régimen de subsidio previo al decreto DOF 01-may-2024 (tabla decreciente
  // de 2013): no modelado. Sólo bloquea si el subsidio está en juego — por
  // encima del tope de ingreso ninguno de los dos regímenes otorga subsidio.
  const sub = subsidioEmpleo(ejercicio);
  const subsidioEnJuego =
    sub != null && isrCalc.baseMensual > 0 && isrCalc.baseMensual <= sub.topeIngresoMensual;
  if (fechaIso < DECRETO_SUBSIDIO_2024 && subsidioEnJuego) {
    return noComparable(
      "Subsidio al empleo previo al decreto del 1-may-2024 (tabla 2013) — régimen no modelado",
      ejercicio
    );
  }
  // Transitorio de ENERO (la UMA del año entra en vigor el 1-feb): sólo está
  // modelado para los ejercicios con pct explícito de enero (2026 en adelante).
  if (mes === 1 && subsidioEnJuego && !(ejercicio === 2026 && sub?.pctUmaMensualEnero != null)) {
    return noComparable(
      `Transitorio de enero del subsidio al empleo no modelado para el ejercicio ${ejercicio}`,
      ejercicio
    );
  }

  // ── IMSS obrero con la UMA del ejercicio ──
  const umaDiaria = umaDiariaDelEjercicio(ejercicio);
  if (umaDiaria == null) {
    return noComparable(`Sin UMA versionada para el ejercicio ${ejercicio}`, ejercicio);
  }
  // El riesgo de puesto sólo afecta la cuota PATRONAL — para la obrera da igual.
  const imssObreroCon = (dias: number) => {
    try {
      return calcularImss({
        salarioBaseCotizacion: entrada.sbcDiario!,
        diasPagados: dias,
        riesgoPuesto: "1",
        ejercicio,
        umaDiaria,
      }).obrero.total;
    } catch {
      return null;
    }
  };
  let imssNuestro = imssObreroCon(entrada.diasPagados);
  if (imssNuestro == null) {
    return noComparable(`Sin referencias IMSS (UMA/SM) para el ejercicio ${ejercicio}`, ejercicio);
  }
  // Convención de días: si con NumDiasPagados no coincide pero el periodo tiene
  // otros días naturales (quincena de 16), probar esa convención — es la que
  // usan muchos proveedores para cotizar IMSS.
  let imssConvencionDias: "diasPagados" | "diasPeriodo" = "diasPagados";
  if (
    Math.abs(imssNuestro - entrada.timbrado.imssObrero) > TOLERANCIA_PESOS &&
    entrada.diasPeriodo != null &&
    entrada.diasPeriodo > 0 &&
    entrada.diasPeriodo !== entrada.diasPagados
  ) {
    const alterno = imssObreroCon(entrada.diasPeriodo);
    if (
      alterno != null &&
      Math.abs(alterno - entrada.timbrado.imssObrero) < Math.abs(imssNuestro - entrada.timbrado.imssObrero)
    ) {
      imssNuestro = alterno;
      imssConvencionDias = "diasPeriodo";
    }
  }

  // ── Subsidio ENTREGADO ──
  // Bajo el decreto vigente (DOF 01-may-2024) el subsidio NO es devolutivo:
  // sólo reduce el ISR hasta cero, nunca se entrega en efectivo. Nuestro
  // entregado esperado es siempre $0.00 — si el proveedor timbró un OtroPago
  // 002 con importe, opera con el mecanismo anterior.
  const subsidioNuestro = 0;

  const isr: ConceptoComparado = {
    nuestro: isrCalc.isrRetenido,
    timbrado: entrada.timbrado.isr,
    delta: r2(isrCalc.isrRetenido - entrada.timbrado.isr),
  };
  const imssObrero: ConceptoComparado = {
    nuestro: imssNuestro,
    timbrado: entrada.timbrado.imssObrero,
    delta: r2(imssNuestro - entrada.timbrado.imssObrero),
  };
  const subsidio: ConceptoComparado = {
    nuestro: subsidioNuestro,
    timbrado: entrada.timbrado.subsidioEntregado,
    delta: r2(subsidioNuestro - entrada.timbrado.subsidioEntregado),
  };

  const coincide =
    Math.abs(isr.delta) <= TOLERANCIA_PESOS &&
    Math.abs(imssObrero.delta) <= TOLERANCIA_PESOS &&
    Math.abs(subsidio.delta) <= TOLERANCIA_PESOS;

  return {
    comparable: true,
    ejercicio,
    isr,
    imssObrero,
    subsidio,
    imssConvencionDias,
    veredicto: coincide ? "coincide" : "difiere",
  };
}

// ── 3. Comparación de una corrida (DB, acotada) ──────────────────────────────

export interface EmpleadoComparacion {
  employeeId: string;
  nombre: string;
  rfc: string;
  cfdiUuid: string | null;
  comparacion: ComparacionRecibo;
}

export interface ComparacionCorrida {
  runId: string;
  /** "YYYY-MM-DD/YYYY-MM-DD" (PayrollRun.periodo). */
  periodo: string;
  fechaPago: string; // ISO date
  empleadosComparados: number; // coinciden + difieren
  coinciden: number;
  difieren: number;
  noComparables: number;
  empleados: EmpleadoComparacion[];
}

/**
 * Compara una corrida completa importada del SAT: por cada PayrollItem toma el
 * rawXml del CFDI vinculado (cfdiUuid), re-parsea los insumos y corre
 * compararRecibo. Devuelve null si la corrida no existe o no es elegible
 * (sólo origen "SAT" y tipo ORDINARIA en v1). SÓLO LECTURA, acotada a
 * MAX_RECIBOS_POR_CORRIDA recibos.
 */
export async function compararCorrida(runId: string): Promise<ComparacionCorrida | null> {
  const run = await prisma.payrollRun.findUnique({
    where: { id: runId },
    select: { id: true, companyId: true, periodo: true, fechaPago: true, tipo: true, origen: true },
  });
  if (!run || run.origen !== "SAT" || run.tipo !== "ORDINARIA") return null;

  const items = await prisma.payrollItem.findMany({
    where: { payrollRunId: runId },
    take: MAX_RECIBOS_POR_CORRIDA,
    select: {
      employeeId: true,
      cfdiUuid: true,
      employee: {
        select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true, rfc: true },
      },
    },
  });

  const uuids = items.map((i) => i.cfdiUuid).filter((u): u is string => u != null);
  const invoices =
    uuids.length > 0
      ? await prisma.invoice.findMany({
          where: { companyId: run.companyId, uuid: { in: uuids } },
          select: { uuid: true, rawXml: true },
        })
      : [];
  const xmlPorUuid = new Map(invoices.map((i) => [i.uuid!.toUpperCase(), i.rawXml]));

  const empleados: EmpleadoComparacion[] = items.map((item) => {
    const nombre = [item.employee.nombre, item.employee.apellidoPaterno, item.employee.apellidoMaterno]
      .filter(Boolean)
      .join(" ");
    const base = {
      employeeId: item.employeeId,
      nombre,
      rfc: item.employee.rfc,
      cfdiUuid: item.cfdiUuid,
    };
    const rawXml = item.cfdiUuid ? xmlPorUuid.get(item.cfdiUuid.toUpperCase()) : null;
    if (!rawXml) {
      return { ...base, comparacion: noComparable("El recibo no tiene XML timbrado vinculado") };
    }
    const entrada = parseEntradaParalelo(rawXml);
    if (!entrada) {
      return { ...base, comparacion: noComparable("El XML del recibo no es legible") };
    }
    return { ...base, comparacion: compararRecibo(entrada) };
  });

  let coinciden = 0;
  let difieren = 0;
  let noComparables = 0;
  for (const e of empleados) {
    if (e.comparacion.veredicto === "coincide") coinciden++;
    else if (e.comparacion.veredicto === "difiere") difieren++;
    else noComparables++;
  }

  return {
    runId: run.id,
    periodo: run.periodo,
    fechaPago: run.fechaPago.toISOString().slice(0, 10),
    empleadosComparados: coinciden + difieren,
    coinciden,
    difieren,
    noComparables,
    empleados,
  };
}

// ── 4. Resumen de las últimas N corridas (DB, acotada) ───────────────────────

export interface HallazgoParalelo {
  runId: string;
  periodo: string;
  fechaPago: string;
  empleado: string;
  rfc: string;
  /** "ISR retenido" | "IMSS obrero" | "Subsidio al empleo". */
  concepto: string;
  timbrado: number;
  nuestro: number;
  delta: number;
}

export interface ResumenParalelo {
  corridas: ComparacionCorrida[];
  global: {
    corridas: number;
    empleadosComparados: number;
    coinciden: number;
    difieren: number;
    noComparables: number;
  };
  /** Conteo de recibos no comparables por motivo. */
  motivosNoComparables: Record<string, number>;
  /** Las diferencias más grandes (|delta| desc), acotadas. */
  hallazgos: HallazgoParalelo[];
  toleranciaPesos: number;
}

const MAX_HALLAZGOS = 10;

/**
 * Recalcula las últimas N corridas ORDINARIAS importadas del SAT de la empresa
 * y agrega el resultado. Cálculo on-demand, sin persistencia; N acotado a
 * MAX_CORRIDAS_RESUMEN.
 */
export async function resumenParalelo(
  companyId: string,
  opts?: { limit?: number }
): Promise<ResumenParalelo> {
  const limit = Math.min(Math.max(Math.trunc(opts?.limit ?? 6), 1), MAX_CORRIDAS_RESUMEN);

  const runs = await prisma.payrollRun.findMany({
    where: { companyId, origen: "SAT", tipo: "ORDINARIA" },
    orderBy: { fechaPago: "desc" },
    take: limit,
    select: { id: true },
  });

  const corridas: ComparacionCorrida[] = [];
  for (const r of runs) {
    const c = await compararCorrida(r.id);
    if (c) corridas.push(c);
  }

  const global = { corridas: corridas.length, empleadosComparados: 0, coinciden: 0, difieren: 0, noComparables: 0 };
  const motivosNoComparables: Record<string, number> = {};
  const hallazgos: HallazgoParalelo[] = [];

  for (const corrida of corridas) {
    global.empleadosComparados += corrida.empleadosComparados;
    global.coinciden += corrida.coinciden;
    global.difieren += corrida.difieren;
    global.noComparables += corrida.noComparables;

    for (const emp of corrida.empleados) {
      const c = emp.comparacion;
      if (c.veredicto === "no-comparable") {
        const motivo = c.motivoNoComparable ?? "Motivo desconocido";
        motivosNoComparables[motivo] = (motivosNoComparables[motivo] ?? 0) + 1;
        continue;
      }
      if (c.veredicto !== "difiere") continue;
      const conceptos: Array<[string, ConceptoComparado | undefined]> = [
        ["ISR retenido", c.isr],
        ["IMSS obrero", c.imssObrero],
        ["Subsidio al empleo", c.subsidio],
      ];
      for (const [concepto, valores] of conceptos) {
        if (!valores || Math.abs(valores.delta) <= TOLERANCIA_PESOS) continue;
        hallazgos.push({
          runId: corrida.runId,
          periodo: corrida.periodo,
          fechaPago: corrida.fechaPago,
          empleado: emp.nombre,
          rfc: emp.rfc,
          concepto,
          timbrado: valores.timbrado,
          nuestro: valores.nuestro,
          delta: valores.delta,
        });
      }
    }
  }

  hallazgos.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    corridas,
    global,
    motivosNoComparables,
    hallazgos: hallazgos.slice(0, MAX_HALLAZGOS),
    toleranciaPesos: TOLERANCIA_PESOS,
  };
}
