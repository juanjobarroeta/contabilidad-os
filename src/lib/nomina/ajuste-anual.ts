// ─────────────────────────────────────────────────────────────────────────────
// Ajuste anual de ISR de sueldos — Art. 97 LISR (cálculo anual del retenedor).
//
// El patrón que retiene conforme al Art. 96 LISR debe calcular el impuesto
// ANUAL de cada trabajador (Art. 97, primer párrafo): a la totalidad de los
// ingresos del ejercicio por el Capítulo I del Título IV se le aplica la tarifa
// anual del Art. 152 y contra el resultado se acreditan los pagos provisionales
// (las retenciones mensuales del Art. 96). La diferencia:
//   - A CARGO  → se retiene al trabajador y se entera a más tardar en FEBRERO
//                del año siguiente (Art. 97, cuarto párrafo).
//   - A FAVOR  → se compensa contra la retención de DICIEMBRE y las
//                retenciones sucesivas, a más tardar dentro del año de
//                calendario posterior (Art. 97, cuarto párrafo); el remanente
//                puede solicitarse en devolución.
//
// NO se hace el cálculo anual (Art. 97, último párrafo) a trabajadores que:
//   a) Iniciaron después del 1 de enero del ejercicio o dejaron de prestar
//      servicios antes del 1 de diciembre → «periodo-incompleto».
//   b) Obtuvieron ingresos anuales del Capítulo que EXCEDAN de $400,000.00 →
//      «ingresos-mayores-400k» (deben presentar su propia declaración anual,
//      Art. 98 fracc. III inciso e).
//   c) Comunicaron por escrito que presentarán declaración anual → esto no es
//      conocible desde los datos; la UI lo expone como marcado por empleado
//      («presentará por su cuenta»), SIN persistencia en v1.
//
// SUBSIDIO PARA EL EMPLEO EN EL CÁLCULO ANUAL — decreto DOF 01-may-2024,
// Artículo Tercero (verificado contra el texto oficial; las modificaciones
// DOF 31-dic-2024 y DOF 31-dic-2025 sólo reforman el Artículo Segundo, así que
// el Tercero sigue vigente para 2024, 2025 y 2026):
//   fracc. I  — al impuesto anual (tarifa Art. 152) se le DISMINUYE «la suma de
//               las cantidades que por concepto de subsidio para el empleo
//               mensual le correspondió al trabajador».
//   fracc. II — si el impuesto del Art. 152 es MAYOR que esa suma, la
//               diferencia es el impuesto a cargo y contra él se acreditan los
//               pagos provisionales del Art. 96.
//   fracc. III— si es MENOR, no hay impuesto a cargo NI se entrega cantidad
//               alguna al trabajador (el subsidio nunca genera saldo a favor).
// Orden legal: primero el subsidio, después el acreditamiento de retenciones.
//
// LO QUE ESTE MÓDULO IMPLEMENTA para el subsidio («le correspondió» = derecho
// del mes según el decreto, NO lo efectivamente aplicado): reconstruye mes por
// mes el derecho al subsidio — si la base gravada del MES de calendario
// (Art. Segundo: «ingresos mensuales que sirvan de base para calcular el
// impuesto sobre la renta», es decir la base gravada, verificado contra el DOF)
// no excede el tope del ejercicio, corresponde el monto único pct × UMA
// mensual. Enero usa el pct transitorio del decreto (14.39% s/UMA 2024 para
// 2025; 15.59% s/UMA 2025 para 2026) porque la UMA del año entra en vigor el
// 1 de febrero (Art. 5 LUMA).
//
// INCERTIDUMBRE DOCUMENTADA (se opta por señalar, no por adivinar):
//   - La agrupación es por MES DE CALENDARIO de la fecha de pago; la mecánica
//     mensual del retenedor mensualiza cada periodo (÷15 × 30.4 en quincenas),
//     por lo que en la frontera del tope ambos métodos pueden divergir por
//     centavos-pesos. El decreto habla del «mes de calendario», que es lo que
//     se implementa aquí.
//   - Ejercicio 2024: de enero a abril rigió la TABLA decreciente del decreto
//     de 2013 (no modelada). Si en esos meses el trabajador pudo tener subsidio
//     en juego (base del mes ≤ tope del decreto 2024, proxy conservador), el
//     cálculo se marca no realizable («subsidio-regimen-2013») en lugar de
//     calcular con un régimen que no está modelado.
//   - El impuesto local a los ingresos por salarios (Art. 97, segundo párrafo)
//     no se registra en el sistema; se asume $0 (correcto en CDMX y en la
//     mayoría de los estados, que no tienen ese impuesto al trabajador).
//   - Trabajadores de salario mínimo: el Art. 96, último párrafo, prohíbe
//     retenerles y el Art. 110 LFT protege el mínimo de descuentos; aplicar el
//     ajuste anual les generaría un cargo irreteneble. Se marcan
//     «salario-minimo» y quedan fuera (se usa el mínimo GENERAL del ejercicio;
//     la ZLFN no es distinguible desde los datos — limitación documentada).
//
// SÓLO LECTURA (v1): este módulo calcula y reporta. NO escribe en corridas ni
// aplica la diferencia a la nómina de diciembre (eso es fase 2).
//
// Piezas (mismo patrón que paralelo.ts):
//   1. calcularAjusteAnualEmpleado(input) — PURA. Todo el cálculo y las
//      exclusiones legales de un trabajador.
//   2. ajusteAnualEmpresa(companyId, ejercicio) — DB, acotada. Reúne los
//      insumos (recibos timbrados del ejercicio + base gravada re-parseada del
//      XML timbrado) y agrega el reporte.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { tarifaAnualPF, subsidioEmpleo, aplicarTarifa } from "../fiscal/tarifas";
import {
  umaDiariaDelEjercicio,
  salarioMinimoGeneralDelEjercicio,
} from "./constants";
import { parseEntradaParalelo } from "./paralelo";

/** Art. 97, último párrafo, inciso b) LISR — tope de ingresos anuales. */
export const LIMITE_INGRESOS_ANUALES_ART97 = 400_000;

// Cálculo on-demand sin persistencia: el costo debe estar acotado.
const MAX_RECIBOS_AJUSTE = 6000;

// Percepciones de separación/retiro (c_TipoPercepcion): su ISR anual tiene
// mecánica propia (Art. 95 LISR — tasa sobre ingreso ordinario) que NO está
// modelada en v1; además el decreto de subsidio las excluye expresamente de la
// base del tope mensual (Art. Segundo).
const PERCEPCIONES_SEPARACION = new Set(["022", "023", "025", "039", "044"]);

const r2 = (n: number) => Math.round(n * 100) / 100;

// ── Tipos ─────────────────────────────────────────────────────────────────────

/** Un recibo timbrado del ejercicio, ya resuelto a los insumos del cálculo. */
export interface ReciboAjuste {
  /** Fecha de pago ISO (YYYY-MM-DD) — determina el mes de calendario. */
  fechaPago: string;
  /**
   * Suma de ImporteGravado del recibo (re-parseada del XML timbrado).
   * null = el XML no está disponible/legible → la base anual es indeterminable.
   */
  gravado: number | null;
  /** Total de percepciones (gravado + exento) — para el tope de $400,000. */
  totalPercepciones: number;
  /** ISR efectivamente retenido en el recibo (deducción 002). */
  isrRetenido: number;
  /** El recibo contiene pagos por separación (finiquito, indemnización…). */
  esSeparacion: boolean;
}

export type MotivoNoAplica =
  | "sin-recibos"
  | "periodo-incompleto"
  | "ingresos-mayores-400k"
  | "pagos-por-separacion"
  | "salario-minimo"
  | "sin-xml"
  | "sin-tarifa"
  | "subsidio-regimen-2013";

export type SentidoDiferencia = "a-cargo" | "a-favor" | "sin-diferencia";

export interface AjusteAnualEmpleadoInput {
  ejercicio: number;
  /** Fecha de ingreso ISO (YYYY-MM-DD); null = desconocida. */
  fechaIngreso: string | null;
  /** Fecha de baja ISO; null = sigue activo con el retenedor. */
  fechaBaja: string | null;
  recibos: ReciboAjuste[];
}

export interface AjusteAnualEmpleadoCalculo {
  estado: "aplica" | "no-aplica";
  motivo: MotivoNoAplica | null;
  motivoDetalle: string | null;
  recibos: number;
  recibosSinXml: number;
  /** Total de percepciones del ejercicio (gravado + exento) — tope Art. 97 b). */
  ingresosTotales: number;
  /** Σ gravado del ejercicio (la base a la que se aplica la tarifa anual). */
  baseAnual: number | null;
  /** ISR anual según la tarifa del Art. 152, ANTES del subsidio. */
  isrTarifaAnual: number | null;
  /** Σ subsidio mensual que le correspondió (decreto, Art. Tercero fracc. I). */
  subsidioAnualCorrespondido: number | null;
  /** Subsidio efectivamente disminuido (topado al ISR anual, fracc. III). */
  subsidioAplicado: number | null;
  mesesConSubsidio: number;
  /** Impuesto anual a cargo tras subsidio: max(0, tarifa − subsidio). */
  isrAnual: number | null;
  /** Σ ISR retenido en el ejercicio (pagos provisionales del Art. 96). */
  retenidoAcumulado: number;
  /** isrAnual − retenidoAcumulado (positiva = a cargo). */
  diferencia: number | null;
  sentido: SentidoDiferencia | null;
  /** Qué implica el resultado en la nómina de diciembre (texto para la UI). */
  accionDiciembre: string;
  advertencias: string[];
}

// ── Subsidio mensual «que le correspondió» (decreto DOF 01-may-2024) ─────────

interface SubsidioMes {
  monto: number;
  /** El mes cae antes de la vigencia del decreto con subsidio en juego. */
  preDecreto: boolean;
  advertencia: string | null;
}

/**
 * Monto del subsidio para el empleo que CORRESPONDIÓ en un mes de calendario
 * (derecho, no lo aplicado): si la base gravada del mes no excede el tope del
 * ejercicio, corresponde pct × UMA mensual (Art. Segundo del decreto). Enero
 * usa el pct transitorio sobre la UMA del año anterior cuando está versionado
 * (2025: 14.39%, DOF 31-dic-2024; 2026: 15.59%, DOF 31-dic-2025).
 */
function subsidioDelMes(ejercicio: number, mes: number, gravadoMes: number): SubsidioMes {
  const sinSubsidio: SubsidioMes = { monto: 0, preDecreto: false, advertencia: null };
  if (gravadoMes <= 0) return sinSubsidio;

  const sub = subsidioEmpleo(ejercicio);
  if (!sub) return sinSubsidio;

  // Tope de ingreso: la base gravada del mes (Art. Segundo: «ingresos mensuales
  // que sirvan de base para calcular el impuesto sobre la renta»).
  if (gravadoMes > sub.topeIngresoMensual) return sinSubsidio;

  // Mes anterior a la vigencia del decreto (ene-abr 2024): regía la tabla 2013,
  // no modelada. El tope del decreto funge como proxy conservador de «subsidio
  // en juego» (la tabla 2013 topaba más abajo, así que nunca sub-detecta).
  const inicioMes = `${ejercicio}-${String(mes).padStart(2, "0")}-01`;
  if (inicioMes < sub.vigenciaDesde) return { monto: 0, preDecreto: true, advertencia: null };

  let advertencia: string | null = null;
  if (sub.ejercicio !== ejercicio) {
    advertencia = `Subsidio al empleo del ejercicio ${ejercicio} resuelto con el decreto de ${sub.ejercicio} (roll-forward) — verifica si hubo modificación publicada.`;
  }

  // Enero: transitorio del decreto (la UMA del año entra en vigor el 1-feb).
  if (mes === 1 && sub.pctUmaMensualEnero != null) {
    const umaAnterior = umaDiariaDelEjercicio(ejercicio - 1);
    if (umaAnterior != null) {
      return { monto: r2(sub.pctUmaMensualEnero * umaAnterior * 30.4), preDecreto: false, advertencia };
    }
  }

  const uma = umaDiariaDelEjercicio(ejercicio);
  if (uma == null) {
    return {
      monto: 0,
      preDecreto: false,
      advertencia: `Sin UMA versionada para el ejercicio ${ejercicio}: el subsidio del mes ${mes} se omitió del cálculo anual.`,
    };
  }
  if (mes === 1 && sub.pctUmaMensualEnero == null) {
    advertencia = `Enero ${ejercicio}: pct transitorio del subsidio no versionado; se usó el pct general del ejercicio.`;
  }
  return { monto: r2(sub.pctUmaMensual * uma * 30.4), preDecreto: false, advertencia };
}

// ── 1. Cálculo PURO por trabajador ───────────────────────────────────────────

function noAplica(
  motivo: MotivoNoAplica,
  motivoDetalle: string,
  parcial: Partial<AjusteAnualEmpleadoCalculo>,
  accionDiciembre = "Sin acción en diciembre: el retenedor no debe efectuar el cálculo anual de este trabajador."
): AjusteAnualEmpleadoCalculo {
  return {
    estado: "no-aplica",
    motivo,
    motivoDetalle,
    recibos: 0,
    recibosSinXml: 0,
    ingresosTotales: 0,
    baseAnual: null,
    isrTarifaAnual: null,
    subsidioAnualCorrespondido: null,
    subsidioAplicado: null,
    mesesConSubsidio: 0,
    isrAnual: null,
    retenidoAcumulado: 0,
    diferencia: null,
    sentido: null,
    accionDiciembre,
    advertencias: [],
    ...parcial,
  };
}

/**
 * Cálculo anual de ISR de UN trabajador (Art. 97 LISR + Art. Tercero del
 * decreto de subsidio). PURA — se prueba con goldens hechos a mano.
 *
 * Orden: exclusiones legales del Art. 97 (periodo incompleto, >$400,000),
 * luego exclusiones de datos/alcance (separación, XML faltante, tarifa,
 * régimen 2013 del subsidio, salario mínimo) y por último la aritmética:
 * base = Σ gravado → tarifa Art. 152 → − subsidio correspondido (piso $0) →
 * − retenciones del Art. 96 → diferencia a cargo / a favor.
 */
export function calcularAjusteAnualEmpleado(
  input: AjusteAnualEmpleadoInput
): AjusteAnualEmpleadoCalculo {
  const { ejercicio, recibos } = input;
  const retenidoAcumulado = r2(recibos.reduce((s, r) => s + r.isrRetenido, 0));
  const ingresosTotales = r2(recibos.reduce((s, r) => s + r.totalPercepciones, 0));
  const recibosSinXml = recibos.filter((r) => r.gravado == null).length;
  const comunes = {
    recibos: recibos.length,
    recibosSinXml,
    ingresosTotales,
    retenidoAcumulado,
  };

  if (recibos.length === 0) {
    return noAplica("sin-recibos", "El trabajador no tiene recibos timbrados en el ejercicio.", comunes);
  }

  // Art. 97, último párrafo, a): periodo incompleto.
  const primerDia = `${ejercicio}-01-01`;
  const primeroDiciembre = `${ejercicio}-12-01`;
  if (input.fechaIngreso != null && input.fechaIngreso > primerDia) {
    return noAplica(
      "periodo-incompleto",
      `Inició la prestación de servicios el ${input.fechaIngreso}, con posterioridad al 1 de enero del ejercicio (Art. 97, último párrafo, inciso a, LISR).`,
      comunes
    );
  }
  if (input.fechaBaja != null && input.fechaBaja < primeroDiciembre) {
    return noAplica(
      "periodo-incompleto",
      `Dejó de prestar servicios el ${input.fechaBaja}, antes del 1 de diciembre del ejercicio (Art. 97, último párrafo, inciso a, LISR).`,
      comunes
    );
  }

  // Art. 97, último párrafo, b): ingresos anuales del Capítulo que EXCEDAN de
  // $400,000 (total de percepciones, gravadas y exentas — el ingreso exento
  // sigue siendo ingreso del Capítulo; la exención vive en el Art. 93).
  if (ingresosTotales > LIMITE_INGRESOS_ANUALES_ART97) {
    return noAplica(
      "ingresos-mayores-400k",
      `Ingresos anuales por salarios de $${ingresosTotales.toLocaleString("es-MX", { minimumFractionDigits: 2 })}, superiores a $400,000.00 (Art. 97, último párrafo, inciso b, LISR).`,
      comunes,
      "El trabajador está obligado a presentar su propia declaración anual (Art. 98, fracc. III, inciso e, LISR); entrégale su constancia de percepciones y retenciones."
    );
  }

  // Pagos por separación: mecánica anual propia (Art. 95 LISR) no modelada en v1.
  if (recibos.some((r) => r.esSeparacion)) {
    return noAplica(
      "pagos-por-separacion",
      "El ejercicio incluye pagos por separación (finiquito/indemnización); su impuesto anual tiene mecánica propia (Art. 95 LISR) que no está modelada en esta versión.",
      comunes,
      "Calcula el ajuste de este trabajador manualmente (Art. 95 LISR) o con tu asesor."
    );
  }

  // Base indeterminable: falta el XML timbrado de algún recibo.
  if (recibosSinXml > 0) {
    return noAplica(
      "sin-xml",
      `${recibosSinXml} recibo(s) del ejercicio sin XML timbrado disponible: la base gravada anual no puede determinarse con precisión. Sincroniza con el SAT y vuelve a intentar.`,
      comunes,
      "Completa la descarga de CFDI del ejercicio para poder calcular el ajuste."
    );
  }

  const baseAnual = r2(recibos.reduce((s, r) => s + (r.gravado ?? 0), 0));

  const tarifa = tarifaAnualPF(ejercicio);
  if (!tarifa) {
    return noAplica(
      "sin-tarifa",
      `Sin tarifa anual ISR (Art. 152 LISR) versionada para el ejercicio ${ejercicio}.`,
      { ...comunes, baseAnual }
    );
  }

  const advertencias: string[] = [];
  if (tarifa.ejercicio !== ejercicio) {
    advertencias.push(
      `Tarifa anual del ejercicio ${ejercicio} resuelta con la tabla de ${tarifa.ejercicio} (roll-forward: el Art. 152 sólo se actualiza cuando la inflación acumulada supera 10%).`
    );
  }
  if (!tarifa.verificado) {
    advertencias.push(`La tarifa anual de ${tarifa.ejercicio} no está cotejada contra el Anexo 8 RMF.`);
  }

  // ── Base gravada por MES de calendario (para el subsidio) ──
  const gravadoPorMes = new Map<number, number>();
  for (const r of recibos) {
    const mes = Number(r.fechaPago.slice(5, 7));
    if (!Number.isFinite(mes) || mes < 1 || mes > 12) continue;
    gravadoPorMes.set(mes, r2((gravadoPorMes.get(mes) ?? 0) + (r.gravado ?? 0)));
  }

  // Salario mínimo: si TODOS los meses con ingreso quedaron en o bajo el mínimo
  // general mensual, el Art. 96 (último párrafo) prohibió retener y el Art. 110
  // LFT protege el mínimo de descuentos — el ajuste anual no debe aplicarse.
  const smDiario = salarioMinimoGeneralDelEjercicio(ejercicio);
  if (smDiario != null) {
    const topeSmMensual = smDiario * 30.4 + 0.01; // misma tolerancia FP que nomina/isr.ts
    const mesesConIngreso = [...gravadoPorMes.values()].filter((g) => g > 0);
    if (mesesConIngreso.length > 0 && mesesConIngreso.every((g) => g <= topeSmMensual)) {
      return noAplica(
        "salario-minimo",
        "Trabajador de salario mínimo: no se le retiene ISR (Art. 96, último párrafo, LISR) y el salario mínimo está protegido contra descuentos (Art. 110 LFT); no se le aplica el ajuste anual.",
        { ...comunes, baseAnual }
      );
    }
  }

  // ── Subsidio anual «que le correspondió» (decreto, Art. Tercero fracc. I) ──
  let subsidioAnualCorrespondido = 0;
  let mesesConSubsidio = 0;
  for (const [mes, gravadoMes] of [...gravadoPorMes.entries()].sort((a, b) => a[0] - b[0])) {
    const s = subsidioDelMes(ejercicio, mes, gravadoMes);
    if (s.preDecreto) {
      // Ene-abr 2024 con subsidio en juego: tabla 2013 no modelada → no calcular.
      return noAplica(
        "subsidio-regimen-2013",
        `En ${ejercicio} los meses previos al decreto del 1 de mayo de 2024 se rigieron por la tabla de subsidio de 2013 (no modelada) y este trabajador pudo tener subsidio en juego; el cálculo anual no puede reconstruirse con certeza.`,
        { ...comunes, baseAnual },
        "Calcula el ajuste de este trabajador manualmente (régimen de subsidio mixto 2024)."
      );
    }
    if (s.advertencia && !advertencias.includes(s.advertencia)) advertencias.push(s.advertencia);
    if (s.monto > 0) {
      subsidioAnualCorrespondido = r2(subsidioAnualCorrespondido + s.monto);
      mesesConSubsidio++;
    }
  }

  // ── Aritmética del Art. 97 + Art. Tercero del decreto ──
  // Impuesto local retenido: no registrado en el sistema → $0 (documentado).
  const isrTarifaAnual = r2(aplicarTarifa(baseAnual, tarifa.filas));
  // fracc. III: el subsidio disminuye hasta dejar el impuesto en cero; jamás
  // genera cantidad a entregar ni saldo a favor por sí mismo.
  const subsidioAplicado = Math.min(subsidioAnualCorrespondido, isrTarifaAnual);
  const isrAnual = r2(Math.max(0, isrTarifaAnual - subsidioAnualCorrespondido));
  const diferencia = r2(isrAnual - retenidoAcumulado);

  const sentido: SentidoDiferencia =
    diferencia > 0 ? "a-cargo" : diferencia < 0 ? "a-favor" : "sin-diferencia";
  if (sentido !== "sin-diferencia" && Math.abs(diferencia) <= 1) {
    advertencias.push(
      "Diferencia menor o igual a $1.00 — efecto normal del redondeo entre la tarifa mensual y la anual."
    );
  }

  const accionDiciembre =
    sentido === "a-cargo"
      ? `Retener $${Math.abs(diferencia).toLocaleString("es-MX", { minimumFractionDigits: 2 })} adicionales en la nómina de diciembre y enterarlos a más tardar en febrero (Art. 97, cuarto párrafo, LISR).`
      : sentido === "a-favor"
        ? `Compensar $${Math.abs(diferencia).toLocaleString("es-MX", { minimumFractionDigits: 2 })} contra la retención de diciembre y las retenciones sucesivas, a más tardar dentro del año siguiente (Art. 97, cuarto párrafo, LISR); el remanente puede solicitarse en devolución.`
        : "Sin ajuste: la retención acumulada coincide con el impuesto anual.";

  return {
    estado: "aplica",
    motivo: null,
    motivoDetalle: null,
    recibos: recibos.length,
    recibosSinXml: 0,
    ingresosTotales,
    baseAnual,
    isrTarifaAnual,
    subsidioAnualCorrespondido,
    subsidioAplicado,
    mesesConSubsidio,
    isrAnual,
    retenidoAcumulado,
    diferencia,
    sentido,
    accionDiciembre,
    advertencias,
  };
}

// ── 2. Reporte de la empresa (DB, acotado) ───────────────────────────────────

export interface AjusteAnualEmpleadoReporte extends AjusteAnualEmpleadoCalculo {
  employeeId: string;
  nombre: string;
  rfc: string;
  numEmpleado: string | null;
}

export interface AjusteAnualReporte {
  ejercicio: number;
  tarifa: { ejercicio: number; fuente: string; verificado: boolean } | null;
  empleados: AjusteAnualEmpleadoReporte[];
  resumen: {
    total: number;
    aplican: number;
    noAplican: number;
    conCargo: number;
    conFavor: number;
    sumaACargo: number;
    sumaAFavor: number;
  };
  advertenciasGlobales: string[];
}

/**
 * Reporte del ajuste anual de TODA la empresa para un ejercicio. SÓLO LECTURA:
 * cálculo on-demand, sin persistencia, acotado a MAX_RECIBOS_AJUSTE recibos.
 *
 * Insumos: PayrollItems de corridas STAMPED/PAID con fecha de pago dentro del
 * ejercicio (la retención sólo es real cuando está timbrada — DRAFT/CALCULATED
 * quedan fuera y se documenta). La base gravada por recibo se re-parsea del XML
 * timbrado (Invoice.uuid ↔ PayrollItem.cfdiUuid, mismo mecanismo que la nómina
 * en paralelo) porque PayrollItem no conserva la partición gravado/exento;
 * cubre por igual recibos nativos timbrados en la app y los importados del SAT.
 * Sin auth — el llamador debe autorizar el acceso a `companyId` antes.
 */
export async function ajusteAnualEmpresa(
  companyId: string,
  ejercicio: number
): Promise<AjusteAnualReporte> {
  const desde = new Date(Date.UTC(ejercicio, 0, 1));
  const hasta = new Date(Date.UTC(ejercicio + 1, 0, 1));

  const tarifaRow = tarifaAnualPF(ejercicio);
  const tarifa = tarifaRow
    ? { ejercicio: tarifaRow.ejercicio, fuente: tarifaRow.fuente, verificado: tarifaRow.verificado }
    : null;

  const items = await prisma.payrollItem.findMany({
    where: {
      payrollRun: {
        companyId,
        status: { in: ["STAMPED", "PAID"] },
        fechaPago: { gte: desde, lt: hasta },
      },
    },
    take: MAX_RECIBOS_AJUSTE + 1,
    select: {
      employeeId: true,
      isrRetenido: true,
      totalPercepciones: true,
      cfdiUuid: true,
      payrollRun: { select: { fechaPago: true, tipo: true } },
      employee: {
        select: {
          nombre: true,
          apellidoPaterno: true,
          apellidoMaterno: true,
          rfc: true,
          numEmpleado: true,
          fechaIngreso: true,
          fechaBaja: true,
        },
      },
    },
  });

  const advertenciasGlobales: string[] = [];
  if (items.length > MAX_RECIBOS_AJUSTE) {
    return {
      ejercicio,
      tarifa,
      empleados: [],
      resumen: { total: 0, aplican: 0, noAplican: 0, conCargo: 0, conFavor: 0, sumaACargo: 0, sumaAFavor: 0 },
      advertenciasGlobales: [
        `La empresa supera el límite de ${MAX_RECIBOS_AJUSTE} recibos por ejercicio para el cálculo en línea; el reporte no se generó.`,
      ],
    };
  }

  // XML timbrado por UUID (en lotes acotados para no armar un IN gigante).
  const uuids = [...new Set(items.map((i) => i.cfdiUuid?.toUpperCase()).filter((u): u is string => u != null))];
  const xmlPorUuid = new Map<string, string>();
  for (let i = 0; i < uuids.length; i += 500) {
    const lote = uuids.slice(i, i + 500);
    const invoices = await prisma.invoice.findMany({
      where: { companyId, uuid: { in: lote }, rawXml: { not: null } },
      select: { uuid: true, rawXml: true },
    });
    for (const inv of invoices) xmlPorUuid.set(inv.uuid!.toUpperCase(), inv.rawXml!);
  }

  // Recibos por empleado (con nombre/fechas del propio join).
  interface EmpleadoAcc {
    nombre: string;
    rfc: string;
    numEmpleado: string | null;
    fechaIngreso: string | null;
    fechaBaja: string | null;
    recibos: ReciboAjuste[];
  }
  const porEmpleado = new Map<string, EmpleadoAcc>();

  for (const item of items) {
    let acc = porEmpleado.get(item.employeeId);
    if (!acc) {
      acc = {
        nombre: [item.employee.nombre, item.employee.apellidoPaterno, item.employee.apellidoMaterno]
          .filter(Boolean)
          .join(" "),
        rfc: item.employee.rfc,
        numEmpleado: item.employee.numEmpleado,
        fechaIngreso: item.employee.fechaIngreso?.toISOString().slice(0, 10) ?? null,
        fechaBaja: item.employee.fechaBaja?.toISOString().slice(0, 10) ?? null,
        recibos: [],
      };
      porEmpleado.set(item.employeeId, acc);
    }

    const rawXml = item.cfdiUuid ? xmlPorUuid.get(item.cfdiUuid.toUpperCase()) : undefined;
    const entrada = rawXml ? parseEntradaParalelo(rawXml) : null;
    const gravadoSeparacion = Object.entries(entrada?.gravadoPorCodigo ?? {}).some(
      ([codigo, monto]) => PERCEPCIONES_SEPARACION.has(codigo) && monto > 0.01
    );

    acc.recibos.push({
      fechaPago: item.payrollRun.fechaPago.toISOString().slice(0, 10),
      gravado: entrada ? entrada.totalGravado : null,
      totalPercepciones: Number(item.totalPercepciones),
      isrRetenido: Number(item.isrRetenido),
      esSeparacion:
        item.payrollRun.tipo === "FINIQUITO" || entrada?.esFiniquito === true || gravadoSeparacion,
    });
  }

  // Empleados activos SIN recibos en el ejercicio: se listan como «sin-recibos»
  // para que el reporte sea exhaustivo (nadie se pierde en silencio).
  const activos = await prisma.employee.findMany({
    where: { companyId, isActive: true },
    select: {
      id: true,
      nombre: true,
      apellidoPaterno: true,
      apellidoMaterno: true,
      rfc: true,
      numEmpleado: true,
      fechaIngreso: true,
      fechaBaja: true,
    },
  });
  for (const e of activos) {
    if (porEmpleado.has(e.id)) continue;
    porEmpleado.set(e.id, {
      nombre: [e.nombre, e.apellidoPaterno, e.apellidoMaterno].filter(Boolean).join(" "),
      rfc: e.rfc,
      numEmpleado: e.numEmpleado,
      fechaIngreso: e.fechaIngreso?.toISOString().slice(0, 10) ?? null,
      fechaBaja: e.fechaBaja?.toISOString().slice(0, 10) ?? null,
      recibos: [],
    });
  }

  const empleados: AjusteAnualEmpleadoReporte[] = [...porEmpleado.entries()]
    .map(([employeeId, acc]) => ({
      employeeId,
      nombre: acc.nombre,
      rfc: acc.rfc,
      numEmpleado: acc.numEmpleado,
      ...calcularAjusteAnualEmpleado({
        ejercicio,
        fechaIngreso: acc.fechaIngreso,
        fechaBaja: acc.fechaBaja,
        recibos: acc.recibos,
      }),
    }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

  const aplican = empleados.filter((e) => e.estado === "aplica");
  const conCargo = aplican.filter((e) => e.sentido === "a-cargo");
  const conFavor = aplican.filter((e) => e.sentido === "a-favor");

  return {
    ejercicio,
    tarifa,
    empleados,
    resumen: {
      total: empleados.length,
      aplican: aplican.length,
      noAplican: empleados.length - aplican.length,
      conCargo: conCargo.length,
      conFavor: conFavor.length,
      sumaACargo: r2(conCargo.reduce((s, e) => s + (e.diferencia ?? 0), 0)),
      sumaAFavor: r2(conFavor.reduce((s, e) => s + Math.abs(e.diferencia ?? 0), 0)),
    },
    advertenciasGlobales,
  };
}
