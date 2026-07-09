// ─── Prestaciones Laborales ──────────────────────────────────────────────────
// Aguinaldo (Art. 87 LFT), Vacaciones + Prima Vacacional (Art. 76, 80 LFT),
// and SDI integration factor calculation.

import {
  UMA_DIARIO,
  SALARIO_MINIMO_GENERAL,
  DIAS_AGUINALDO_MINIMO,
  AGUINALDO_EXENTO_UMA,
  PRIMA_VACACIONAL_PCT_MINIMO,
  PRIMA_VACACIONAL_EXENTO_UMA,
  getDiasVacaciones,
} from "./constants";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Compute full years of seniority between two dates */
export function aniosAntiguedad(fechaIngreso: Date, fechaCorte: Date): number {
  const ingreso = new Date(fechaIngreso);
  const corte = new Date(fechaCorte);
  let years = corte.getFullYear() - ingreso.getFullYear();
  const monthDiff = corte.getMonth() - ingreso.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && corte.getDate() < ingreso.getDate())) {
    years--;
  }
  return Math.max(0, years);
}

/** Days worked between two dates (inclusive) */
function diasTrabajados(fechaIngreso: Date, fechaCorte: Date): number {
  const ingreso = new Date(fechaIngreso);
  const corte = new Date(fechaCorte);
  const diff = corte.getTime() - ingreso.getTime();
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)) + 1);
}

// ─── Aguinaldo ───────────────────────────────────────────────────────────────

export type AguinaldoInput = {
  salarioDiario: number;
  fechaIngreso: Date;
  fechaCorte: Date; // typically Dec 31
  diasAguinaldo?: number; // default 15 (LFT minimum)
  /** UMA diaria del ejercicio de pago para la exención. Default: la vigente (constants). */
  umaDiaria?: number;
  /**
   * Monto ajustado manualmente (vista previa editable de la corrida de
   * aguinaldo): sustituye la fórmula salarioDiario × días proporcionales,
   * pero la exención de 30 UMA (Art. 93 fracc. XIV LISR) se aplica igual —
   * el ajuste manual nunca decide gravado/exento a mano.
   */
  montoOverride?: number;
};

export type AguinaldoResult = {
  diasCorrespondientes: number;
  /** Días trabajados del ejercicio considerados en la proporción (tope 365). */
  diasTrabajadosEjercicio: number;
  montoTotal: number;
  montoExento: number;
  montoGravado: number;
};

export function calcularAguinaldo(input: AguinaldoInput): AguinaldoResult {
  const { salarioDiario, fechaIngreso, fechaCorte } = input;
  const diasAguinaldo = input.diasAguinaldo ?? DIAS_AGUINALDO_MINIMO;
  const uma = input.umaDiaria ?? UMA_DIARIO;

  // Proporcional a los días trabajados del ejercicio (Art. 87 LFT, segundo
  // párrafo: quienes no cumplieron el año tienen derecho a la parte
  // proporcional). Divisor 365 por convención — en bisiestos se conserva 365
  // (simplificación documentada, criterio de práctica generalizada).
  const dias = diasTrabajados(fechaIngreso, fechaCorte);
  const diasEnElAnio = Math.min(dias, 365);
  const diasCorrespondientes = r2((diasEnElAnio / 365) * diasAguinaldo);

  const montoTotal =
    input.montoOverride != null ? r2(input.montoOverride) : r2(diasCorrespondientes * salarioDiario);

  // Exempt: 30 × UMA diario (Art. 93 LISR fraction XIV)
  const montoExento = r2(Math.min(montoTotal, AGUINALDO_EXENTO_UMA * uma));
  const montoGravado = r2(Math.max(0, montoTotal - montoExento));

  return { diasCorrespondientes, diasTrabajadosEjercicio: diasEnElAnio, montoTotal, montoExento, montoGravado };
}

// ─── Vacaciones + Prima Vacacional ───────────────────────────────────────────

export type VacacionesInput = {
  salarioDiario: number;
  fechaIngreso: Date;
  fechaCorte: Date;
  primaVacacionalPct?: number; // default 0.25 (25%)
  diasVacacionesTomar?: number; // if specified, overrides the full entitlement
};

export type VacacionesResult = {
  anios: number;
  diasVacaciones: number; // entitlement per LFT
  diasATomar: number;
  pagoVacaciones: number;
  montoPrimaVacacional: number;
  primaExenta: number;
  primaGravada: number;
};

export function calcularVacaciones(input: VacacionesInput): VacacionesResult {
  const { salarioDiario, fechaIngreso, fechaCorte } = input;
  const primaPct = input.primaVacacionalPct ?? PRIMA_VACACIONAL_PCT_MINIMO;

  const anios = aniosAntiguedad(fechaIngreso, fechaCorte);
  const diasVacaciones = getDiasVacaciones(anios);
  const diasATomar = input.diasVacacionesTomar ?? diasVacaciones;

  const pagoVacaciones = r2(diasATomar * salarioDiario);
  const montoPrimaVacacional = r2(diasATomar * salarioDiario * primaPct);

  // Exempt: 15 × UMA diario (Art. 93 LISR fraction XIV)
  const primaExenta = r2(Math.min(montoPrimaVacacional, PRIMA_VACACIONAL_EXENTO_UMA * UMA_DIARIO));
  const primaGravada = r2(Math.max(0, montoPrimaVacacional - primaExenta));

  return {
    anios,
    diasVacaciones,
    diasATomar,
    pagoVacaciones,
    montoPrimaVacacional,
    primaExenta,
    primaGravada,
  };
}

// ─── Prima vacacional por días tomados en el periodo ─────────────────────────
// Para la captura de incidencias: cuando el empleado toma vacaciones DENTRO de
// una corrida ordinaria, los días de vacaciones se pagan como sueldo normal
// (sin cambio) y lo que se agrega es la prima vacacional de esos días.
//
// Base legal:
// - Prima vacacional: mínimo 25% sobre el salario de los días de vacaciones
//   (Art. 80 LFT).
// - Exención ISR: hasta 15 UMA diarias por la prima vacacional pagada
//   (Art. 93 fracc. XIV LISR). La exención aplica POR PAGO de prima; aquí se
//   aplica completa al pago del periodo — si la empresa fracciona la prima en
//   varios periodos, la exención podría duplicarse (simplificación documentada;
//   el criterio conservador es pagar la prima en una sola exhibición).

export type PrimaVacacionalPorDiasInput = {
  salarioDiario: number;
  diasVacaciones: number;
  primaVacacionalPct?: number; // default 0.25 (Art. 80 LFT)
  /** UMA diaria a usar para la exención. Default: la vigente (constants). */
  umaDiaria?: number;
};

export type PrimaVacacionalPorDiasResult = {
  monto: number;
  exenta: number;
  gravada: number;
};

export function calcularPrimaVacacionalPorDias(
  input: PrimaVacacionalPorDiasInput
): PrimaVacacionalPorDiasResult {
  const pct = input.primaVacacionalPct ?? PRIMA_VACACIONAL_PCT_MINIMO;
  const uma = input.umaDiaria ?? UMA_DIARIO;
  const monto = r2(input.diasVacaciones * input.salarioDiario * pct);
  // Exención: 15 × UMA diaria (Art. 93 fracc. XIV LISR).
  const exenta = r2(Math.min(monto, PRIMA_VACACIONAL_EXENTO_UMA * uma));
  const gravada = r2(Math.max(0, monto - exenta));
  return { monto, exenta, gravada };
}

// ─── Horas extra: pago y exención ISR ────────────────────────────────────────
// Base legal:
// - LFT Art. 66: la jornada extraordinaria no puede exceder 3 horas diarias ni
//   3 veces por semana (máximo 9 horas dobles a la semana).
// - LFT Art. 67: las horas extra dentro de ese límite se pagan al 100%
//   adicional (dobles).
// - LFT Art. 68: las horas que excedan de 9 a la semana se pagan al 200%
//   adicional (triples).
// - LISR Art. 93 fracc. I:
//   · Trabajadores de salario mínimo: 100% exentas las remuneraciones por
//     tiempo extraordinario DENTRO del límite de la LFT.
//   · Demás trabajadores: exento el 50% de esas remuneraciones (las que están
//     dentro del límite LFT) SIN exceder 5 UMA por cada semana de servicios.
//   · Las horas que exceden el límite legal (triples, o dobles fuera del
//     límite) son 100% gravadas (último párrafo de la fracción).
//
// SIMPLIFICACIÓN DOCUMENTADA (aproximación estándar por periodo): la ley
// controla el límite por SEMANA de servicios; en una captura por periodo
// (quincena/mes) no se conoce la distribución semanal exacta. Se aproxima con
// semanas = round(díasPeriodo / 7) (mínimo 1): el límite de dobles exentables
// es 9 h × semanas y el tope de exención es 5 UMA × semanas. Las horas
// capturadas como TRIPLES ya exceden el límite por definición (Art. 68) y se
// gravan al 100%. La jornada se asume de 8 horas (máximo diurno, Art. 61 LFT)
// para valuar la hora ordinaria.

export type HorasExtraInput = {
  salarioDiario: number;
  /** Horas pagadas al doble (Art. 67 LFT). */
  horasDobles: number;
  /** Horas pagadas al triple (Art. 68 LFT — exceden el límite legal). */
  horasTriples?: number;
  /** Días del periodo de pago (para aproximar las semanas de servicios). */
  diasPeriodo: number;
  /** UMA diaria del ejercicio (tope 5 UMA/semana). Default: la vigente. */
  umaDiaria?: number;
  /** Salario mínimo diario aplicable (exención 100% a salario mínimo). Default: el general vigente. */
  salarioMinimoDiario?: number;
  /** Horas de la jornada diaria para valuar la hora ordinaria. Default: 8 (Art. 61 LFT). */
  horasJornada?: number;
};

export type HorasExtraResult = {
  /** Semanas de servicios aproximadas del periodo. */
  semanas: number;
  /** Horas dobles dentro del límite LFT (9 h/semana) — las únicas con exención. */
  horasDoblesDentroLimite: number;
  pagoDobles: number;
  pagoTriples: number;
  montoTotal: number;
  montoExento: number;
  montoGravado: number;
  /** True si aplicó la exención del 100% por salario mínimo. */
  exentoSalarioMinimo: boolean;
};

export function calcularHorasExtra(input: HorasExtraInput): HorasExtraResult {
  const horasJornada = input.horasJornada ?? 8;
  const uma = input.umaDiaria ?? UMA_DIARIO;
  const salarioMinimo = input.salarioMinimoDiario ?? SALARIO_MINIMO_GENERAL;
  const horasTriples = input.horasTriples ?? 0;

  const valorHora = input.salarioDiario / horasJornada;
  // Aproximación por periodo (ver nota arriba): semanas de servicios.
  const semanas = Math.max(1, Math.round(input.diasPeriodo / 7));

  // Límite LFT de jornada extraordinaria doble: 3 h/día × 3 veces/semana = 9 h
  // por semana (Arts. 66-67 LFT). Sólo estas horas tienen exención de ISR.
  const limiteDobles = 9 * semanas;
  const horasDoblesDentroLimite = Math.min(input.horasDobles, limiteDobles);

  const pagoDobles = r2(input.horasDobles * valorHora * 2);
  const pagoTriples = r2(horasTriples * valorHora * 3);
  const pagoDoblesDentroLimite = r2(horasDoblesDentroLimite * valorHora * 2);
  const montoTotal = r2(pagoDobles + pagoTriples);

  // Exención (Art. 93 fracc. I LISR):
  const exentoSalarioMinimo = input.salarioDiario <= salarioMinimo;
  let montoExento: number;
  if (exentoSalarioMinimo) {
    // Salario mínimo: 100% exento dentro del límite LFT.
    montoExento = pagoDoblesDentroLimite;
  } else {
    // Demás trabajadores: 50% de lo pagado dentro del límite, con tope de
    // 5 UMA por semana de servicios.
    montoExento = r2(Math.min(0.5 * pagoDoblesDentroLimite, 5 * uma * semanas));
  }
  const montoGravado = r2(Math.max(0, montoTotal - montoExento));

  return {
    semanas,
    horasDoblesDentroLimite,
    pagoDobles,
    pagoTriples,
    montoTotal,
    montoExento,
    montoGravado,
    exentoSalarioMinimo,
  };
}

// ─── SDI Factor de Integración ───────────────────────────────────────────────
// Factor real por antigüedad: 1 + (aguinaldo/365) + (vacaciones × prima / 365).
//
// Las vacaciones que se integran son las del AÑO DE SERVICIO EN CURSO (años
// cumplidos + 1), no las del año ya cumplido: al alta el trabajador va a
// devengar las del año 1 (12 días, reforma 2023 → factor mínimo 1.0493) y en
// cada aniversario el SBC se modifica con los días del año que INICIA (año 2 =
// 14 días → 1.0507, etc.). Así lo esperan las modificaciones salariales ante
// el IMSS (IDSE).

export function calcularFactorIntegracion(
  fechaIngreso: Date,
  fechaCalculo: Date,
  diasAguinaldo?: number,
  primaVacacionalPct?: number
): number {
  const aguinaldo = diasAguinaldo ?? DIAS_AGUINALDO_MINIMO;
  const prima = primaVacacionalPct ?? PRIMA_VACACIONAL_PCT_MINIMO;
  const anios = aniosAntiguedad(fechaIngreso, fechaCalculo);
  const diasVac = getDiasVacaciones(anios + 1); // año de servicio en curso

  const factor = 1 + (aguinaldo / 365) + (diasVac * prima / 365);
  return Math.round(factor * 10000) / 10000; // 4 decimal places
}
