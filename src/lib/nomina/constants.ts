// ─── Nómina Constants ────────────────────────────────────────────────────────
// Central source of truth for UMA, IMSS rates, and payroll reference values.
// UMA is updated annually by INEGI (typically February). Update the env var
// and redeploy when the new value is published.

export const UMA_DIARIO = parseFloat(process.env.UMA_DIARIO ?? "113.14");
export const UMA_MENSUAL = UMA_DIARIO * 30.4;
export const UMA_ANUAL = UMA_DIARIO * 365;

// SBC topes
export const TOPE_SBC_25_UMA = UMA_DIARIO * 25;
export const TRES_UMA = UMA_DIARIO * 3;

// ─── IMSS Rate Tables ────────────────────────────────────────────────────────
// All rates as decimals. Source: Ley del Seguro Social, Arts. 25, 106, 107,
// 147, 168, 211.

/** Riesgo de Trabajo primas by class (employer-only) */
export const RIESGO_TRABAJO_PRIMAS: Record<string, number> = {
  "1": 0.0054355,
  "2": 0.0113065,
  "3": 0.0253530,
  "4": 0.0437550,
  "5": 0.0750000,
};

/**
 * IMSS rate structure per ramo (branch).
 * `base` describes what the rate is applied to:
 *   - "SBC": salario base cotización × días
 *   - "EXCEDENTE_3UMA": portion of SBC above 3 UMA × días
 *   - "UMA": UMA diario × días (fixed quota, not SBC-based)
 */
export const IMSS_RAMOS = [
  {
    nombre: "EyM Especie Fija",
    obrero: 0,
    patronal: 0.2040,
    base: "UMA" as const,
  },
  {
    nombre: "EyM Especie Excedente",
    obrero: 0.004,
    patronal: 0.011,
    base: "EXCEDENTE_3UMA" as const,
  },
  {
    nombre: "EyM Dinero",
    obrero: 0.0025,
    patronal: 0.007,
    base: "SBC" as const,
  },
  {
    nombre: "EyM Gastos Médicos Pensionados",
    obrero: 0.00375,
    patronal: 0.01050,
    base: "SBC" as const,
  },
  {
    nombre: "Invalidez y Vida",
    obrero: 0.00625,
    patronal: 0.01750,
    base: "SBC" as const,
  },
  {
    nombre: "Retiro",
    obrero: 0,
    patronal: 0.02,
    base: "SBC" as const,
  },
  {
    nombre: "Cesantía y Vejez",
    obrero: 0.01125,
    patronal: 0.0315,
    base: "SBC" as const,
  },
  {
    nombre: "Guarderías",
    obrero: 0,
    patronal: 0.01,
    base: "SBC" as const,
  },
] as const;

// ─── LFT Vacation Days (Art. 76, 2023 reform) ───────────────────────────────
export const VACATION_DAYS_TABLE: { minYears: number; maxYears: number; days: number }[] = [
  { minYears: 1, maxYears: 1, days: 12 },
  { minYears: 2, maxYears: 2, days: 14 },
  { minYears: 3, maxYears: 3, days: 16 },
  { minYears: 4, maxYears: 4, days: 18 },
  { minYears: 5, maxYears: 5, days: 20 },
  { minYears: 6, maxYears: 10, days: 22 },
  { minYears: 11, maxYears: 15, days: 24 },
  { minYears: 16, maxYears: 20, days: 26 },
  { minYears: 21, maxYears: 25, days: 28 },
  { minYears: 26, maxYears: 30, days: 30 },
  { minYears: 31, maxYears: 35, days: 32 },
];

/** Get vacation days for a given number of complete years of seniority */
export function getDiasVacaciones(aniosAntiguedad: number): number {
  if (aniosAntiguedad < 1) return 0;
  const row = VACATION_DAYS_TABLE.find(
    (r) => aniosAntiguedad >= r.minYears && aniosAntiguedad <= r.maxYears
  );
  if (row) return row.days;
  // Beyond 35 years: continues at +2 every 5 years from 32
  return 32 + Math.floor((aniosAntiguedad - 35) / 5) * 2;
}

// ─── Aguinaldo ───────────────────────────────────────────────────────────────
export const DIAS_AGUINALDO_MINIMO = 15; // LFT Art. 87
export const AGUINALDO_EXENTO_UMA = 30;  // 30 × UMA diario

// ─── Prima Vacacional ────────────────────────────────────────────────────────
export const PRIMA_VACACIONAL_PCT_MINIMO = 0.25; // 25% LFT Art. 80
export const PRIMA_VACACIONAL_EXENTO_UMA = 15;   // 15 × UMA diario

// ─── PTU ─────────────────────────────────────────────────────────────────────
export const PTU_PCT = 0.10; // 10% of renta gravable
export const PTU_EXENTO_UMA = 15; // 15 × UMA diario
