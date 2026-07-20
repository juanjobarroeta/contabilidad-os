// ─── Pure Nómina Calculation ─────────────────────────────────────────────────
// Called by both standalone emission and batch payroll runs. No DB or Facturapi
// calls — just math.

import type { Employee, PayrollRunType } from "@prisma/client";
import { calcularIsrRetenido } from "./isr";
import { calcularImss, type ImssCalcResult } from "./imss";
import { calcularInfonavit } from "./infonavit";
import {
  calcularAguinaldo,
  calcularVacaciones,
  calcularHorasExtra,
  calcularPrimaVacacionalPorDias,
  type AguinaldoResult,
  type VacacionesResult,
  type HorasExtraResult,
} from "./prestaciones";
import { calcularPtu, type PtuDistribucion } from "./ptu";
import type { IncidenciasResumen } from "./incidencias";
import { calcularDescuentosRecurrentes } from "./descuentos-recurrentes";
import { umaDiariaDelEjercicio, salarioMinimoGeneralDelEjercicio } from "./constants";

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type PercepcionItem = {
  tipoPercepcion: string; // SAT code: "001" Sueldos, "002" Aguinaldo, "003" PTU, "021" Prima vac
  clave: string;
  concepto: string;
  importeGravado: number;
  importeExento: number;
};

export type DeduccionItem = {
  tipoDeduccion: string; // SAT code: "001" IMSS, "002" ISR, "006" Infonavit, "010" aportaciones
  clave: string;
  concepto: string;
  importe: number;
};

export type NominaCalcInput = {
  employee: Employee & { tipoDescuentoInfonavit?: string | null };
  diasPagados: number;
  tipo: PayrollRunType;
  sueldoBruto?: number;
  /** Ejercicio fiscal (año de la fecha de pago) — selecciona tarifa/subsidio. Default: año actual. */
  ejercicio?: number;
  /** Mes de la fecha de pago (1-12) — sólo afecta el subsidio de enero (transitorio). */
  mes?: number;
  // For AGUINALDO
  diasAguinaldo?: number;
  fechaCorte?: Date;
  /** Monto de aguinaldo ajustado a mano en la vista previa (sustituye la fórmula; la exención se recalcula igual). */
  aguinaldoMontoOverride?: number;
  // For VACACIONES
  diasVacacionesTomar?: number;
  primaVacacionalPct?: number;
  // For PTU (single-employee slice from calcularPtu)
  ptuMonto?: number;
  ptuExento?: number;
  /**
   * Incidencias del periodo (sólo ORDINARIA/EXTRAORDINARIA): faltas,
   * incapacidades, horas extra, vacaciones, bonos, comisiones y descuentos.
   * Ver src/lib/nomina/incidencias.ts para el tratamiento por tipo.
   */
  incidencias?: IncidenciasResumen;
};

export type NominaCalcResult = {
  percepciones: PercepcionItem[];
  deducciones: DeduccionItem[];
  totalPercepciones: number;
  totalDeducciones: number;
  netoAPagar: number;
  imssCalc: ImssCalcResult;
  isrRetenido: number;
  /** False cuando la tarifa/subsidio usados están vencidos o sin cotejar (ver nomina/isr.ts). */
  isrTarifaVerificada: boolean;
  imssObrero: number;
  imssPatronal: number;
  infonavitDeduccion: number;
  tipoNomina: "O" | "E"; // Ordinaria vs Extraordinaria
  /**
   * Días efectivamente pagados del periodo tras descontar faltas e
   * incapacidades. Sin incidencias es igual a diasPagados. Es el número de
   * días que debe reportar el CFDI (num_dias_pagados) y con el que cotiza IMSS.
   */
  diasEfectivos: number;
  /** Desglose de horas extra del periodo (cuando hubo). */
  horasExtraResult?: HorasExtraResult;
  // Extraordinary details
  aguinaldoResult?: AguinaldoResult;
  vacacionesResult?: VacacionesResult;
  ptuDistribucion?: PtuDistribucion;
};

export function calcularNomina(input: NominaCalcInput): NominaCalcResult {
  const { employee, diasPagados, tipo } = input;
  const sdi = employee.salarioDiarioIntegrado ?? employee.salarioDiario;

  // ── Determine tipo_nomina ──
  const tipoNomina: "O" | "E" =
    tipo === "ORDINARIA" ? "O" : "E";

  // ── Incidencias del periodo (sólo nómina de sueldo) ──
  const inc = (tipo === "ORDINARIA" || tipo === "EXTRAORDINARIA") ? input.incidencias : undefined;

  // Días NO pagados del periodo:
  // - Faltas y permisos sin goce: no generan salario (Art. 82 LFT — el salario
  //   retribuye el trabajo prestado).
  // - Incapacidades: el patrón no paga esos días; el subsidio lo cubre el IMSS
  //   (enfermedad general desde el 4o día, Art. 96 LSS; riesgo de trabajo y
  //   maternidad al 100% desde el día 1, Arts. 58 y 101 LSS). SIMPLIFICACIÓN
  //   DOCUMENTADA: todos los días de incapacidad capturados se tratan como no
  //   pagados por el patrón y quedan fuera de la base de ISR; los 3 días de
  //   espera de enfermedad general (sin subsidio IMSS) sólo se pagan si el
  //   contrato lo pacta — en tal caso capturarlos como PERMISO_CON_GOCE.
  // Los días de VACACIONES no reducen nada: se pagan como sueldo normal.
  const diasNoPagados = Math.min(
    diasPagados,
    (inc?.diasFalta ?? 0) + (inc?.diasIncapacidad ?? 0)
  );
  // Días efectivos: base del sueldo, del CFDI (num_dias_pagados) y de la
  // cotización IMSS/INFONAVIT del periodo. SIMPLIFICACIÓN DOCUMENTADA (IMSS):
  // se reducen TODOS los ramos proporcionalmente; en estricto, por faltas
  // subsiste la cuota fija de EyM hasta 7 días/mes (Art. 31 fracc. I LSS) y en
  // incapacidades subsiste sólo el ramo de Retiro (Art. 31 fracc. IV LSS) —
  // el ajuste fino lo aplica SUA al determinar las cuotas definitivas.
  const diasEfectivos = diasPagados - diasNoPagados;

  // ── Percepciones ──
  const percepciones: PercepcionItem[] = [];
  let totalGravado = 0;
  let totalExento = 0;
  let aguinaldoResult: AguinaldoResult | undefined;
  let vacacionesResult: VacacionesResult | undefined;
  let horasExtraResult: HorasExtraResult | undefined;

  // Valores UMA/SM del ejercicio de pago (año-conscientes, como ISR/IMSS);
  // si el ejercicio no está versionado se usan los vigentes de constants.
  const ejercicio = input.ejercicio ?? new Date().getFullYear();
  const umaEjercicio = umaDiariaDelEjercicio(ejercicio) ?? undefined;
  const smEjercicio = salarioMinimoGeneralDelEjercicio(ejercicio) ?? undefined;

  if (tipo === "ORDINARIA" || tipo === "EXTRAORDINARIA") {
    const sueldoBruto = input.sueldoBruto ?? r2(employee.salarioDiario * diasEfectivos);
    percepciones.push({
      tipoPercepcion: "001",
      clave: "001",
      concepto: "Sueldos, Salarios y Rayas",
      importeGravado: sueldoBruto,
      importeExento: 0,
    });
    totalGravado = sueldoBruto;

    // Horas extra: dobles con exención del Art. 93 fracc. I LISR (100% para
    // salario mínimo; 50% con tope 5 UMA/semana para los demás), triples 100%
    // gravadas. Ver calcularHorasExtra (prestaciones.ts) para la base legal y
    // la aproximación semanal documentada.
    // NOTA SBC (simplificación documentada): el tiempo extraordinario dentro
    // de los márgenes de la LFT NO integra el SBC (Art. 27 fracc. IX LSS); el
    // excedente habitual y los bonos/comisiones recurrentes sí integran como
    // elemento variable (Arts. 27 y 30 LSS) mediante la modificación
    // bimestral de salario — eso se administra en la ficha del empleado y los
    // movimientos IMSS, no en el cálculo del periodo.
    if (inc && (inc.horasExtraDobles > 0 || inc.horasExtraTriples > 0)) {
      horasExtraResult = calcularHorasExtra({
        salarioDiario: employee.salarioDiario,
        horasDobles: inc.horasExtraDobles,
        horasTriples: inc.horasExtraTriples,
        diasPeriodo: diasPagados,
        umaDiaria: umaEjercicio,
        salarioMinimoDiario: smEjercicio,
      });
      if (horasExtraResult.montoTotal > 0) {
        percepciones.push({
          tipoPercepcion: "019", // c_TipoPercepcion 019 — Horas extra
          clave: "019",
          concepto: "Horas Extra",
          importeGravado: horasExtraResult.montoGravado,
          importeExento: horasExtraResult.montoExento,
        });
        totalGravado = r2(totalGravado + horasExtraResult.montoGravado);
        totalExento = r2(totalExento + horasExtraResult.montoExento);
      }
    }

    // Vacaciones tomadas en el periodo: los días se pagan como sueldo normal
    // (ya vienen dentro de diasEfectivos); lo que se agrega es la prima
    // vacacional del 25% (Art. 80 LFT) con exención de 15 UMA (Art. 93
    // fracc. XIV LISR).
    if (inc && inc.diasVacaciones > 0) {
      const prima = calcularPrimaVacacionalPorDias({
        salarioDiario: employee.salarioDiario,
        diasVacaciones: inc.diasVacaciones,
        primaVacacionalPct: input.primaVacacionalPct,
        umaDiaria: umaEjercicio,
      });
      if (prima.monto > 0) {
        percepciones.push({
          tipoPercepcion: "021", // c_TipoPercepcion 021 — Prima vacacional
          clave: "021",
          concepto: "Prima Vacacional",
          importeGravado: prima.gravada,
          importeExento: prima.exenta,
        });
        totalGravado = r2(totalGravado + prima.gravada);
        totalExento = r2(totalExento + prima.exenta);
      }
    }

    // Bonos / gratificaciones / destajo: 100% gravados — son ingresos por la
    // prestación de un servicio personal subordinado (Art. 94 LISR) sin
    // exención en el Art. 93; tributan con la tarifa ordinaria del periodo
    // (Art. 96 LISR).
    if (inc && inc.bonos > 0) {
      percepciones.push({
        tipoPercepcion: "038", // c_TipoPercepcion 038 — Otros ingresos por salarios
        clave: "038",
        concepto: "Bono / Gratificación",
        importeGravado: r2(inc.bonos),
        importeExento: 0,
      });
      totalGravado = r2(totalGravado + inc.bonos);
    }

    // Comisiones: mismo tratamiento — 100% gravadas (Arts. 94 y 96 LISR).
    if (inc && inc.comisiones > 0) {
      percepciones.push({
        tipoPercepcion: "028", // c_TipoPercepcion 028 — Comisiones
        clave: "028",
        concepto: "Comisiones",
        importeGravado: r2(inc.comisiones),
        importeExento: 0,
      });
      totalGravado = r2(totalGravado + inc.comisiones);
    }

  } else if (tipo === "AGUINALDO") {
    aguinaldoResult = calcularAguinaldo({
      salarioDiario: employee.salarioDiario,
      fechaIngreso: employee.fechaIngreso,
      fechaCorte: input.fechaCorte ?? new Date(new Date().getFullYear(), 11, 31),
      diasAguinaldo: input.diasAguinaldo,
      umaDiaria: umaEjercicio,
      montoOverride: input.aguinaldoMontoOverride,
    });
    percepciones.push({
      tipoPercepcion: "002",
      clave: "002",
      concepto: "Gratificación Anual (Aguinaldo)",
      importeGravado: aguinaldoResult.montoGravado,
      importeExento: aguinaldoResult.montoExento,
    });
    totalGravado = aguinaldoResult.montoGravado;
    totalExento = aguinaldoResult.montoExento;

  } else if (tipo === "VACACIONES") {
    vacacionesResult = calcularVacaciones({
      salarioDiario: employee.salarioDiario,
      fechaIngreso: employee.fechaIngreso,
      fechaCorte: input.fechaCorte ?? new Date(),
      primaVacacionalPct: input.primaVacacionalPct,
      diasVacacionesTomar: input.diasVacacionesTomar,
    });
    // Vacation pay itself (gravado)
    percepciones.push({
      tipoPercepcion: "001",
      clave: "001",
      concepto: "Vacaciones",
      importeGravado: vacacionesResult.pagoVacaciones,
      importeExento: 0,
    });
    // Prima vacacional (partially exempt)
    percepciones.push({
      tipoPercepcion: "021",
      clave: "021",
      concepto: "Prima Vacacional",
      importeGravado: vacacionesResult.primaGravada,
      importeExento: vacacionesResult.primaExenta,
    });
    totalGravado = vacacionesResult.pagoVacaciones + vacacionesResult.primaGravada;
    totalExento = vacacionesResult.primaExenta;

  } else if (tipo === "PTU") {
    const montoTotal = input.ptuMonto ?? 0;
    const montoExento = input.ptuExento ?? 0;
    const montoGravado = r2(montoTotal - montoExento);
    percepciones.push({
      tipoPercepcion: "003",
      clave: "003",
      concepto: "Participación de los Trabajadores en las Utilidades (PTU)",
      importeGravado: montoGravado,
      importeExento: montoExento,
    });
    totalGravado = montoGravado;
    totalExento = montoExento;
  }

  const totalPercepciones = r2(totalGravado + totalExento);

  // ── Deducciones ──
  const deducciones: DeduccionItem[] = [];

  // ISR on gravado portion.
  //
  // MÉTODO PARA PAGOS EXTRAORDINARIOS (aguinaldo, PTU, etc. — DOCUMENTADO):
  // se aplica la tarifa ORDINARIA mensual del Art. 96 LISR sobre la porción
  // gravada del pago (periodicidad "05"). Este método es válido y es el que
  // más retiene. El Art. 174 del RLISR ofrece un método OPCIONAL (elevar la
  // gratificación a proporción mensual, calcular la tasa marginal sobre el
  // sueldo ordinario + esa proporción y aplicarla sólo al gravado), que suele
  // retener menos; requiere el sueldo mensual ordinario del empleado en el
  // punto de cálculo. PENDIENTE DOCUMENTADO: ofrecer el método del Art. 174
  // RLISR como opción de la corrida especial en una iteración futura.
  const isrCalc = calcularIsrRetenido({
    baseGravable: totalGravado,
    periodicidadPago: tipo === "ORDINARIA" ? employee.periodicidadPago : "05", // monthly equiv for extraordinary
    ejercicio: input.ejercicio,
    mes: input.mes,
  });
  if (isrCalc.isrRetenido > 0) {
    deducciones.push({
      tipoDeduccion: "002",
      clave: "002",
      concepto: "ISR",
      importe: isrCalc.isrRetenido,
    });
  }

  // IMSS — only on ORDINARIA. Cotiza sobre los días EFECTIVOS del periodo:
  // las faltas e incapacidades reducen los días de cotización (Art. 31 LSS;
  // ver simplificación documentada arriba — todos los ramos proporcionales).
  const imssCalc = calcularImss({
    salarioBaseCotizacion: sdi,
    diasPagados: diasEfectivos,
    riesgoPuesto: employee.riesgoPuesto,
    // Columna del ejercicio para la CEAV patronal progresiva (DOF 16-dic-2020).
    ejercicio: input.ejercicio,
    // Art. 36 LSS: al trabajador de salario mínimo no se le retiene IMSS
    // (la cuota obrera la absorbe el patrón).
    salarioDiario: employee.salarioDiario,
  });
  if (tipo === "ORDINARIA" && imssCalc.obrero.total > 0) {
    deducciones.push({
      tipoDeduccion: "001",
      clave: "001",
      concepto: "IMSS",
      importe: imssCalc.obrero.total,
    });
  }

  // Infonavit — only on ORDINARIA. Igual que IMSS, sobre días efectivos.
  let infonavitDeduccion = 0;
  if (tipo === "ORDINARIA") {
    infonavitDeduccion = calcularInfonavit({
      tipoDescuento: employee.tipoDescuentoInfonavit ?? null,
      descuentoInfonavit: employee.descuentoInfonavit ?? null,
      salarioBaseCotizacion: sdi,
      diasPagados: diasEfectivos,
    });
    if (infonavitDeduccion > 0) {
      deducciones.push({
        tipoDeduccion: "010",
        clave: "006",
        concepto: "INFONAVIT",
        importe: infonavitDeduccion,
      });
    }
  }

  // FONACOT y pensión alimenticia — deducciones NETAS recurrentes de la ficha
  // del empleado, sólo en ORDINARIA (ver alcance documentado en
  // descuentos-recurrentes.ts). No alteran base de ISR ni cotización IMSS.
  if (tipo === "ORDINARIA") {
    const recurrentes = calcularDescuentosRecurrentes({
      descuentoFonacot: employee.descuentoFonacot ?? null,
      pensionAlimenticiaTipo: employee.pensionAlimenticiaTipo ?? null,
      pensionAlimenticiaValor: employee.pensionAlimenticiaValor ?? null,
      periodicidadPago: employee.periodicidadPago,
      diasPagados: diasEfectivos,
      totalPercepciones,
      deduccionesLey: r2(
        isrCalc.isrRetenido + imssCalc.obrero.total + infonavitDeduccion
      ),
    });
    if (recurrentes.pensionAlimenticia > 0) {
      deducciones.push({
        tipoDeduccion: "007",
        clave: "007",
        concepto: "Pensión alimenticia",
        importe: recurrentes.pensionAlimenticia,
      });
    }
    if (recurrentes.fonacot > 0) {
      deducciones.push({
        tipoDeduccion: "011",
        clave: "011",
        concepto: "FONACOT (abonos)",
        importe: recurrentes.fonacot,
      });
    }
  }

  // Descuentos capturados (préstamos, uniformes, etc.): deducción NETA
  // post-impuestos — no altera la base gravable de ISR ni el SBC/días de
  // cotización IMSS; sólo reduce el neto a pagar. c_TipoDeduccion 004 (Otros).
  if (inc && inc.descuentos > 0) {
    deducciones.push({
      tipoDeduccion: "004",
      clave: "004",
      concepto: "Otros descuentos",
      importe: r2(inc.descuentos),
    });
  }

  const totalDeducciones = r2(deducciones.reduce((s, d) => s + d.importe, 0));
  const netoAPagar = r2(totalPercepciones - totalDeducciones);

  return {
    percepciones,
    deducciones,
    totalPercepciones,
    totalDeducciones,
    netoAPagar,
    imssCalc,
    isrRetenido: isrCalc.isrRetenido,
    isrTarifaVerificada: isrCalc.tarifaVerificada,
    imssObrero: tipo === "ORDINARIA" ? imssCalc.obrero.total : 0,
    imssPatronal: imssCalc.patronal.total,
    infonavitDeduccion,
    tipoNomina,
    diasEfectivos,
    horasExtraResult,
    aguinaldoResult,
    vacacionesResult,
  };
}
