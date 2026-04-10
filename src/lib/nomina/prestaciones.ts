// ─── Prestaciones Laborales ──────────────────────────────────────────────────
// Aguinaldo (Art. 87 LFT), Vacaciones + Prima Vacacional (Art. 76, 80 LFT),
// and SDI integration factor calculation.

import {
  UMA_DIARIO,
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
};

export type AguinaldoResult = {
  diasCorrespondientes: number;
  montoTotal: number;
  montoExento: number;
  montoGravado: number;
};

export function calcularAguinaldo(input: AguinaldoInput): AguinaldoResult {
  const { salarioDiario, fechaIngreso, fechaCorte } = input;
  const diasAguinaldo = input.diasAguinaldo ?? DIAS_AGUINALDO_MINIMO;

  // Proportional if less than 1 full year
  const dias = diasTrabajados(fechaIngreso, fechaCorte);
  const diasEnElAnio = Math.min(dias, 365);
  const diasCorrespondientes = r2((diasEnElAnio / 365) * diasAguinaldo);

  const montoTotal = r2(diasCorrespondientes * salarioDiario);

  // Exempt: 30 × UMA diario (Art. 93 LISR fraction XIV)
  const montoExento = r2(Math.min(montoTotal, AGUINALDO_EXENTO_UMA * UMA_DIARIO));
  const montoGravado = r2(Math.max(0, montoTotal - montoExento));

  return { diasCorrespondientes, montoTotal, montoExento, montoGravado };
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

// ─── SDI Factor de Integración ───────────────────────────────────────────────
// Real factor based on seniority: 1 + (aguinaldo/365) + (vacaciones × prima / 365)

export function calcularFactorIntegracion(
  fechaIngreso: Date,
  fechaCalculo: Date,
  diasAguinaldo?: number,
  primaVacacionalPct?: number
): number {
  const aguinaldo = diasAguinaldo ?? DIAS_AGUINALDO_MINIMO;
  const prima = primaVacacionalPct ?? PRIMA_VACACIONAL_PCT_MINIMO;
  const anios = aniosAntiguedad(fechaIngreso, fechaCalculo);
  const diasVac = getDiasVacaciones(Math.max(1, anios)); // at least year 1

  const factor = 1 + (aguinaldo / 365) + (diasVac * prima / 365);
  return Math.round(factor * 10000) / 10000; // 4 decimal places
}
