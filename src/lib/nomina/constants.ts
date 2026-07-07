// ─── Nómina Constants ────────────────────────────────────────────────────────
// Central source of truth for UMA, IMSS rates, and payroll reference values.
// UMA is updated annually by INEGI and enters into force on FEBRUARY 1st
// (Art. 5 LUMA). Update the env var and redeploy when the new value publishes.

// UMA 2026: $117.31 diaria (INEGI, vigente 1-feb-2026).
// Ejercicio que representan los valores hardcodeados — lo usa el chequeo de
// cobertura para avisar cuando el año en curso ya rebasó el valor cargado.
export const UMA_EJERCICIO = 2026;
export const SALARIO_MINIMO_EJERCICIO = 2026;
export const UMA_DIARIO = parseFloat(process.env.UMA_DIARIO ?? "117.31");
export const UMA_MENSUAL = UMA_DIARIO * 30.4;
export const UMA_ANUAL = UMA_DIARIO * 365;

// UMA 2025 (histórica, fija): la usa el transitorio del subsidio al empleo de
// enero 2026 (DOF 31-dic-2025), porque en enero aún rige la UMA del año previo.
export const UMA_DIARIO_2025 = 113.14;
export const UMA_MENSUAL_2025 = UMA_DIARIO_2025 * 30.4;

// ─── Salario mínimo ──────────────────────────────────────────────────────────
// Vigentes desde el 1-ene-2026 (CONASAMI, resolución dic-2025):
//   General: $315.04 (+13% vs $278.80 de 2025)
//   Zona Libre de la Frontera Norte: $440.87 (+5% vs $419.88 de 2025)
// Env overridea ambos para el ajuste anual.
export const SALARIO_MINIMO_GENERAL = parseFloat(process.env.SALARIO_MINIMO_GENERAL ?? "315.04");
export const SALARIO_MINIMO_ZLFN = parseFloat(process.env.SALARIO_MINIMO_ZLFN ?? "440.87");

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
    // CUIDADO: desde 2023 la cuota patronal de CEAV es PROGRESIVA por el SBC
    // del trabajador (Art. 168 fracc. II LSS reformado, DOF 16-dic-2020, y
    // Artículo Segundo Transitorio del Decreto). El 0.0315 de aquí es sólo el
    // piso legal (SBC ≤ 1.00 salario mínimo); imss.ts lo sustituye por
    // ceavPatronalRate(sbcDiario, ejercicio). La cuota OBRERA sí sigue fija
    // en 1.125% — la reforma no la tocó.
    nombre: "Cesantía y Vejez",
    obrero: 0.01125,
    patronal: 0.0315, // NO usar directamente: ver ceavPatronalRate()
    base: "SBC" as const,
  },
  {
    nombre: "Guarderías",
    obrero: 0,
    patronal: 0.01,
    base: "SBC" as const,
  },
] as const;

// ─── CEAV: cuota patronal progresiva (reforma de pensiones 2020) ─────────────
// Base legal:
//   - Ley del Seguro Social, Art. 168 fracc. II, reformado por el "Decreto por
//     el que se reforman, adicionan y derogan diversas disposiciones de la Ley
//     del Seguro Social y de la Ley de los Sistemas de Ahorro para el Retiro"
//     (DOF 16-dic-2020): la cuota patronal de Cesantía en edad avanzada y
//     Vejez deja de ser fija (3.150%) y se determina según el SBC del
//     trabajador conforme a una tabla progresiva (tope 2030: 11.875%).
//   - Artículo Segundo Transitorio del mismo Decreto: el incremento es
//     GRADUAL, con una columna por ejercicio de 2023 a 2030. Hasta el
//     31-dic-2022 siguió aplicando el 3.150% parejo. A partir de 2031 rige de
//     forma definitiva la columna 2030 (tabla del Art. 168 reformado).
//
// Bandas (Artículo Segundo Transitorio): la banda más baja está expresada en
// SALARIO MÍNIMO — "1.00 SM" conserva 3.150% — y las demás en múltiplos de
// UMA (1.01 SM a 1.50 UMA, 1.51 a 2.00 UMA, ... 4.01 UMA en adelante). Como el
// salario mínimo ya rebasa varias veces la UMA (2026: 1 SM = 315.04 ≈ 2.69
// UMA), los rangos nominales del DOF se traslapan/dejan huecos; el criterio
// operativo (el que aplica el propio IMSS en SUA) es: SBC ≤ 1.00 SM general →
// 3.150%; SBC mayor → clasificar por SBC/UMA con límite superior INCLUSIVE
// (≤ 1.50 UMA cae en la banda 1.01-1.50; a partir de 1.51 en la siguiente).
//
// Al estilo de src/lib/fiscal/tarifas.ts: datos versionados por ejercicio con
// bandera `verificado` y fuente explícita — los ajustes futuros entran por PR
// auditable, nunca silenciosos.

export interface CeavBandaUma {
  /** Límite superior de la banda en múltiplos de UMA (INCLUSIVE); null = sin tope (4.01 en adelante). */
  hastaUma: number | null;
  /** Cuota patronal como decimal (0.03676 = 3.676%). */
  tasa: number;
}

export interface CeavPatronalVersionada {
  ejercicio: number;
  fuente: string;
  /** True una vez cotejada contra la tabla del Artículo Segundo Transitorio (DOF 16-dic-2020). */
  verificado: boolean;
  /** Banda en SALARIO MÍNIMO (no UMA): SBC ≤ 1.00 SM general conserva 3.150% todos los años. */
  tasaHastaUnSm: number;
  /** Bandas superiores por SBC/UMA, ascendentes por hastaUma. */
  bandas: CeavBandaUma[];
}

// Tabla íntegra del Artículo Segundo Transitorio (DOF 16-dic-2020), columnas
// 2023-2030. Cotejada contra la reproducción del Decreto por PwC México
// ("Incremento de las Cuotas Patronales de la Rama de Cesantía en Edad
// Avanzada", oct-2022); 2025 y 2026 re-cotejadas además contra las tablas
// publicadas para esos ejercicios (Manuel Nevárez y Asociados, Fortia). La
// progresión es lineal por banda: p.ej. 4.01+ sube 1.090625 pts/año de 3.150%
// (2022) a 11.875% (2030).
export const CEAV_PATRONAL_TABLAS: CeavPatronalVersionada[] = [
  {
    ejercicio: 2023,
    fuente: "Art. Segundo Transitorio, Decreto reforma LSS/LSAR (DOF 16-dic-2020), columna 2023",
    verificado: true,
    tasaHastaUnSm: 0.0315,
    bandas: [
      { hastaUma: 1.5, tasa: 0.03281 },
      { hastaUma: 2.0, tasa: 0.03575 },
      { hastaUma: 2.5, tasa: 0.03751 },
      { hastaUma: 3.0, tasa: 0.03869 },
      { hastaUma: 3.5, tasa: 0.03953 },
      { hastaUma: 4.0, tasa: 0.04016 },
      { hastaUma: null, tasa: 0.04241 },
    ],
  },
  {
    ejercicio: 2024,
    fuente: "Art. Segundo Transitorio, Decreto reforma LSS/LSAR (DOF 16-dic-2020), columna 2024",
    verificado: true,
    tasaHastaUnSm: 0.0315,
    bandas: [
      { hastaUma: 1.5, tasa: 0.03413 },
      { hastaUma: 2.0, tasa: 0.04 },
      { hastaUma: 2.5, tasa: 0.04353 },
      { hastaUma: 3.0, tasa: 0.04588 },
      { hastaUma: 3.5, tasa: 0.04756 },
      { hastaUma: 4.0, tasa: 0.04882 },
      { hastaUma: null, tasa: 0.05331 },
    ],
  },
  {
    ejercicio: 2025,
    fuente:
      "Art. Segundo Transitorio, Decreto reforma LSS/LSAR (DOF 16-dic-2020), columna 2025 — re-cotejada vs tablas CEAV 2025 publicadas",
    verificado: true,
    tasaHastaUnSm: 0.0315,
    bandas: [
      { hastaUma: 1.5, tasa: 0.03544 },
      { hastaUma: 2.0, tasa: 0.04426 },
      { hastaUma: 2.5, tasa: 0.04954 },
      { hastaUma: 3.0, tasa: 0.05307 },
      { hastaUma: 3.5, tasa: 0.05559 },
      { hastaUma: 4.0, tasa: 0.05747 },
      { hastaUma: null, tasa: 0.06422 },
    ],
  },
  {
    ejercicio: 2026,
    fuente:
      "Art. Segundo Transitorio, Decreto reforma LSS/LSAR (DOF 16-dic-2020), columna 2026 — re-cotejada vs tablas CEAV 2026 publicadas (nov-2025)",
    verificado: true,
    tasaHastaUnSm: 0.0315,
    bandas: [
      { hastaUma: 1.5, tasa: 0.03676 },
      { hastaUma: 2.0, tasa: 0.04851 },
      { hastaUma: 2.5, tasa: 0.05556 },
      { hastaUma: 3.0, tasa: 0.06026 },
      { hastaUma: 3.5, tasa: 0.06361 },
      { hastaUma: 4.0, tasa: 0.06613 },
      { hastaUma: null, tasa: 0.07513 },
    ],
  },
  {
    ejercicio: 2027,
    fuente: "Art. Segundo Transitorio, Decreto reforma LSS/LSAR (DOF 16-dic-2020), columna 2027",
    verificado: true,
    tasaHastaUnSm: 0.0315,
    bandas: [
      { hastaUma: 1.5, tasa: 0.03807 },
      { hastaUma: 2.0, tasa: 0.05276 },
      { hastaUma: 2.5, tasa: 0.06157 },
      { hastaUma: 3.0, tasa: 0.06745 },
      { hastaUma: 3.5, tasa: 0.07164 },
      { hastaUma: 4.0, tasa: 0.07479 },
      { hastaUma: null, tasa: 0.08603 },
    ],
  },
  {
    ejercicio: 2028,
    fuente: "Art. Segundo Transitorio, Decreto reforma LSS/LSAR (DOF 16-dic-2020), columna 2028",
    verificado: true,
    tasaHastaUnSm: 0.0315,
    bandas: [
      { hastaUma: 1.5, tasa: 0.03939 },
      { hastaUma: 2.0, tasa: 0.05701 },
      { hastaUma: 2.5, tasa: 0.06759 },
      { hastaUma: 3.0, tasa: 0.07464 },
      { hastaUma: 3.5, tasa: 0.07967 },
      { hastaUma: 4.0, tasa: 0.08345 },
      { hastaUma: null, tasa: 0.09694 },
    ],
  },
  {
    ejercicio: 2029,
    fuente: "Art. Segundo Transitorio, Decreto reforma LSS/LSAR (DOF 16-dic-2020), columna 2029",
    verificado: true,
    tasaHastaUnSm: 0.0315,
    bandas: [
      { hastaUma: 1.5, tasa: 0.0407 },
      { hastaUma: 2.0, tasa: 0.06126 },
      { hastaUma: 2.5, tasa: 0.0736 },
      { hastaUma: 3.0, tasa: 0.08183 },
      { hastaUma: 3.5, tasa: 0.0877 },
      { hastaUma: 4.0, tasa: 0.09211 },
      { hastaUma: null, tasa: 0.10784 },
    ],
  },
  {
    // Columna final: coincide con la tabla definitiva del Art. 168 fracc. II
    // LSS reformado; rige para 2030 y ejercicios posteriores.
    ejercicio: 2030,
    fuente: "Art. 168 fracc. II LSS reformado / Art. Segundo Transitorio (DOF 16-dic-2020), columna 2030",
    verificado: true,
    tasaHastaUnSm: 0.0315,
    bandas: [
      { hastaUma: 1.5, tasa: 0.04202 },
      { hastaUma: 2.0, tasa: 0.06552 },
      { hastaUma: 2.5, tasa: 0.07962 },
      { hastaUma: 3.0, tasa: 0.08902 },
      { hastaUma: 3.5, tasa: 0.09573 },
      { hastaUma: 4.0, tasa: 0.10077 },
      { hastaUma: null, tasa: 0.11875 },
    ],
  },
];

/**
 * UMA diaria y salario mínimo general diario por ejercicio, para clasificar la
 * banda CEAV. Históricos (INEGI / CONASAMI) fijos; el ejercicio vigente usa
 * las constantes env-overridables de arriba. Al publicarse UMA/SM de un nuevo
 * ejercicio, agregar aquí su renglón — sin renglón, ceavPatronalRate lanza
 * error en vez de clasificar con referencias equivocadas.
 *
 * Simplificación documentada: la UMA entra en vigor el 1-FEB (Art. 5 LUMA),
 * así que en enero estrictamente clasifica la UMA del año previo; aquí se usa
 * la UMA del ejercicio completo.
 */
export const CEAV_REFERENCIAS: Record<number, { umaDiaria: number; salarioMinimoDiario: number }> = {
  2023: { umaDiaria: 103.74, salarioMinimoDiario: 207.44 },
  2024: { umaDiaria: 108.57, salarioMinimoDiario: 248.93 },
  2025: { umaDiaria: UMA_DIARIO_2025, salarioMinimoDiario: 278.8 },
  2026: { umaDiaria: UMA_DIARIO, salarioMinimoDiario: SALARIO_MINIMO_GENERAL },
};

/**
 * UMA diaria VIGENTE en un ejercicio (histórica para 2023-2025 vía
 * CEAV_REFERENCIAS; la env-overridable para el ejercicio cargado). Devuelve
 * null cuando el ejercicio no está versionado — el llamador decide si puede
 * calcular con otro año (respuesta corta: no; ver nómina en paralelo).
 */
export function umaDiariaDelEjercicio(ejercicio: number): number | null {
  if (ejercicio === UMA_EJERCICIO) return UMA_DIARIO;
  return CEAV_REFERENCIAS[ejercicio]?.umaDiaria ?? null;
}

/** Salario mínimo GENERAL diario vigente en un ejercicio; null si no versionado. */
export function salarioMinimoGeneralDelEjercicio(ejercicio: number): number | null {
  if (ejercicio === SALARIO_MINIMO_EJERCICIO) return SALARIO_MINIMO_GENERAL;
  return CEAV_REFERENCIAS[ejercicio]?.salarioMinimoDiario ?? null;
}

/** Tolerancia para que un SBC construido como múltiplo exacto de UMA (p.ej. 1.50 × UMA) no brinque de banda por flotantes. */
const CEAV_UMA_EPS = 1e-9;

/**
 * Cuota patronal de Cesantía en edad avanzada y Vejez (decimal) para un SBC
 * diario y ejercicio dados. Progresiva desde 2023 (DOF 16-dic-2020).
 *
 * - `ejercicio` ≤ 2022 → 3.150% fijo (régimen previo a la reforma).
 * - `ejercicio` > 2030 → columna 2030 (tabla definitiva del Art. 168).
 * - Banda más baja: SBC ≤ 1.00 salario mínimo GENERAL → 3.150%. Para ZLFN u
 *   otro mínimo aplicable, pasar `referencias` con ese salario mínimo.
 * - Sin referencias UMA/SM del ejercicio (ni renglón en CEAV_REFERENCIAS ni
 *   parámetro) lanza Error: nunca clasificamos con valores de otro año.
 */
export function ceavPatronalRate(
  sbcDiario: number,
  ejercicio: number,
  referencias?: { umaDiaria: number; salarioMinimoDiario: number }
): number {
  // Hasta 31-dic-2022 siguió vigente la cuota fija del Art. 168 pre-reforma.
  if (ejercicio <= 2022) return 0.0315;

  const columna = Math.min(ejercicio, 2030);
  const tabla = CEAV_PATRONAL_TABLAS.find((t) => t.ejercicio === columna);
  if (!tabla) {
    // Inalcanzable con la tabla completa 2023-2030; guardia explícita por si
    // una edición futura elimina un renglón.
    throw new Error(`CEAV: no hay columna ${columna} en CEAV_PATRONAL_TABLAS`);
  }

  const refs = referencias ?? CEAV_REFERENCIAS[ejercicio];
  if (!refs) {
    throw new Error(
      `CEAV ${ejercicio}: sin UMA/salario mínimo de referencia. Agregar el ejercicio a CEAV_REFERENCIAS (constants.ts) o pasar referencias explícitas.`
    );
  }

  // Banda 1 (en SM, no UMA): SBC hasta 1.00 salario mínimo conserva 3.150%.
  if (sbcDiario <= refs.salarioMinimoDiario) return tabla.tasaHastaUnSm;

  const enUma = sbcDiario / refs.umaDiaria;
  for (const banda of tabla.bandas) {
    if (banda.hastaUma === null || enUma <= banda.hastaUma + CEAV_UMA_EPS) {
      return banda.tasa;
    }
  }
  // Inalcanzable: la última banda es abierta (hastaUma null).
  return tabla.bandas[tabla.bandas.length - 1].tasa;
}

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

// ─── Vales de despensa ───────────────────────────────────────────────────────
// Mes comercial para prorratear montos mensuales a días del periodo —
// consistente con UMA_MENSUAL (30.4 = 365 / 12).
export const DIAS_MES_COMERCIAL = 30.4;
// Tope de exención operativo: 40% de la UMA diaria por día trabajado
// (ver base legal y simplificación documentada en calcularValesDespensa,
// prestaciones.ts).
export const VALES_DESPENSA_EXENTO_PCT_UMA = 0.4;
