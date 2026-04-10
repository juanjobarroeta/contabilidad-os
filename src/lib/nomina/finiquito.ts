// ─── Finiquito / Liquidación Calculation ─────────────────────────────────────
// Art. 50, 162, 484, 485, 486, 487, 488, 489 LFT
//
// Finiquito (voluntary/justified): proportional aguinaldo + vacaciones + prima + salarios
// Liquidación (unjustified termination): finiquito + 3 months + 20 days/year + seniority premium

import { UMA_DIARIO, AGUINALDO_EXENTO_UMA, PRIMA_VACACIONAL_EXENTO_UMA, DIAS_AGUINALDO_MINIMO } from "./constants";
import { aniosAntiguedad, calcularAguinaldo, calcularVacaciones } from "./prestaciones";

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type FiniquitoInput = {
  salarioDiario: number;
  salarioDiarioIntegrado: number;
  fechaIngreso: Date;
  fechaBaja: Date;
  motivo: "VOLUNTARIA" | "JUSTIFICADA" | "INJUSTIFICADA";
  diasSalarioPendiente?: number; // Days of unpaid salary
  diasVacacionesPendientes?: number; // Vacation days not taken
  diasAguinaldo?: number; // Company-specific (default 15)
  primaVacacionalPct?: number; // Company-specific (default 25%)
};

export type FiniquitoDesglose = {
  // Base components (always present)
  salariosPendientes: number;
  aguinaldoProporcional: number;
  aguinaldoExento: number;
  aguinaldoGravado: number;
  vacacionesProporcionales: number;
  primaVacacional: number;
  primaVacacionalExenta: number;
  primaVacacionalGravada: number;

  // Liquidación components (only for INJUSTIFICADA)
  indemnizacion3Meses: number;       // 3 months of SDI (Art. 50)
  indemnizacion20Dias: number;       // 20 days per year worked (Art. 50)
  primaAntiguedad: number;           // 12 days per year, capped at 2× SMG (Art. 162)
  primaAntiguedadExenta: number;

  // Totals
  subtotalFiniquito: number;
  subtotalLiquidacion: number;
  totalBruto: number;
  totalExento: number;
  totalGravado: number;
};

export type FiniquitoResult = {
  input: FiniquitoInput;
  aniosAntiguedad: number;
  diasTrabajadosEnAnio: number;
  desglose: FiniquitoDesglose;
};

export function calcularFiniquito(input: FiniquitoInput): FiniquitoResult {
  const {
    salarioDiario, salarioDiarioIntegrado,
    fechaIngreso, fechaBaja, motivo,
    diasSalarioPendiente = 0,
    diasAguinaldo = DIAS_AGUINALDO_MINIMO,
    primaVacacionalPct = 0.25,
  } = input;

  const anios = aniosAntiguedad(fechaIngreso, fechaBaja);

  // Days worked in current year (for proportional aguinaldo)
  const yearStart = new Date(fechaBaja.getFullYear(), 0, 1);
  const effectiveStart = fechaIngreso > yearStart ? fechaIngreso : yearStart;
  const diasEnElAnio = Math.max(1,
    Math.floor((fechaBaja.getTime() - effectiveStart.getTime()) / (1000 * 60 * 60 * 24)) + 1
  );

  // ── Salarios pendientes ──
  const salariosPendientes = r2(salarioDiario * diasSalarioPendiente);

  // ── Aguinaldo proporcional ──
  const aguinaldoCalc = calcularAguinaldo({
    salarioDiario,
    fechaIngreso,
    fechaCorte: fechaBaja,
    diasAguinaldo,
  });

  // ── Vacaciones proporcionales ──
  const vacCalc = calcularVacaciones({
    salarioDiario,
    fechaIngreso,
    fechaCorte: fechaBaja,
    primaVacacionalPct,
    diasVacacionesTomar: input.diasVacacionesPendientes,
  });
  const vacacionesProporcionales = vacCalc.pagoVacaciones;
  const primaVacacional = vacCalc.montoPrimaVacacional;

  // ── Subtotal finiquito (all termination types get this) ──
  const subtotalFiniquito = r2(
    salariosPendientes + aguinaldoCalc.montoTotal + vacacionesProporcionales + primaVacacional
  );

  // ── Liquidación components (only for unjustified termination) ──
  let indemnizacion3Meses = 0;
  let indemnizacion20Dias = 0;
  let primaAntiguedad = 0;
  let primaAntiguedadExenta = 0;

  if (motivo === "INJUSTIFICADA") {
    // 3 months of integrated daily salary (Art. 50 LFT)
    indemnizacion3Meses = r2(salarioDiarioIntegrado * 90);

    // 20 days per year worked (Art. 50 LFT)
    indemnizacion20Dias = r2(salarioDiarioIntegrado * 20 * Math.max(1, anios));

    // Prima de antigüedad: 12 days per year, capped at 2× UMA (Art. 162 LFT)
    const salarioCapped = Math.min(salarioDiario, UMA_DIARIO * 2);
    primaAntiguedad = r2(salarioCapped * 12 * Math.max(1, anios));
    // Exempt: 90 × UMA for prima de antigüedad
    primaAntiguedadExenta = r2(Math.min(primaAntiguedad, UMA_DIARIO * 90));
  } else if (motivo === "VOLUNTARIA" && anios >= 15) {
    // Voluntary with 15+ years gets prima de antigüedad only (Art. 162)
    const salarioCapped = Math.min(salarioDiario, UMA_DIARIO * 2);
    primaAntiguedad = r2(salarioCapped * 12 * anios);
    primaAntiguedadExenta = r2(Math.min(primaAntiguedad, UMA_DIARIO * 90));
  }

  const subtotalLiquidacion = r2(indemnizacion3Meses + indemnizacion20Dias + primaAntiguedad);

  // ── Totals ──
  const totalBruto = r2(subtotalFiniquito + subtotalLiquidacion);

  const totalExento = r2(
    aguinaldoCalc.montoExento + vacCalc.primaExenta + primaAntiguedadExenta
  );
  const totalGravado = r2(totalBruto - totalExento);

  return {
    input,
    aniosAntiguedad: anios,
    diasTrabajadosEnAnio: diasEnElAnio,
    desglose: {
      salariosPendientes,
      aguinaldoProporcional: aguinaldoCalc.montoTotal,
      aguinaldoExento: aguinaldoCalc.montoExento,
      aguinaldoGravado: aguinaldoCalc.montoGravado,
      vacacionesProporcionales,
      primaVacacional,
      primaVacacionalExenta: vacCalc.primaExenta,
      primaVacacionalGravada: vacCalc.primaGravada,
      indemnizacion3Meses,
      indemnizacion20Dias,
      primaAntiguedad,
      primaAntiguedadExenta,
      subtotalFiniquito,
      subtotalLiquidacion,
      totalBruto,
      totalExento,
      totalGravado,
    },
  };
}
