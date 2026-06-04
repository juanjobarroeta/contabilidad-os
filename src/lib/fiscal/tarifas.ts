// ─────────────────────────────────────────────────────────────────────────────
// Tarifas ISR — versioned, git-tracked source of truth.
//
// Tax tariffs are correctness-critical: they belong in code review, with explicit
// vigencia (effective dates) and provenance, NOT in a live DB an agent writes to
// silently. The future fiscal-monitoring agent maintains these via PRs (detect →
// flag → reviewed update), so every change to a number that lands on a SAT
// declaración is auditable in git history.
//
// `verificado: false` marks a table that has NOT yet been checked against the
// authoritative source (Anexo 8 RMF). Callers should surface that so a figure
// is never silently trusted on a real filing.
// ─────────────────────────────────────────────────────────────────────────────

export interface TarifaRow {
  /** Límite inferior (inclusive). The bracket is the highest limiteInferior ≤ base. */
  limiteInferior: number;
  /** Cuota fija for the bracket. */
  cuotaFija: number;
  /** Tasa marginal sobre el excedente del límite inferior (decimal). */
  tasaExcedente: number;
}

export interface TarifaVersionada {
  ejercicio: number;
  vigenciaDesde: string; // ISO date, inclusive
  vigenciaHasta: string | null; // ISO date, inclusive; null = open-ended
  fuente: string;
  /** True once checked against the authoritative published source. */
  verificado: boolean;
  /** Ascending by limiteInferior. */
  filas: TarifaRow[];
}

// ── Tarifa ANUAL ISR personas físicas (Art. 152 LISR) ────────────────────────
// 2024 values. Identical to the table currently inlined in declaracion-anual.ts
// — TODO: make that module import from here so there is a single source of truth.
const TARIFA_ANUAL_PF: TarifaVersionada[] = [
  {
    ejercicio: 2024,
    vigenciaDesde: "2024-01-01",
    vigenciaHasta: "2024-12-31",
    fuente: "Art. 152 LISR / Anexo 8 RMF 2024 (DOF 29-dic-2023, fracc. II)",
    verificado: true,
    filas: [
      { limiteInferior: 0.01, cuotaFija: 0, tasaExcedente: 0.0192 },
      { limiteInferior: 8952.5, cuotaFija: 171.88, tasaExcedente: 0.064 },
      { limiteInferior: 75984.56, cuotaFija: 4461.94, tasaExcedente: 0.1088 },
      { limiteInferior: 133536.08, cuotaFija: 10723.55, tasaExcedente: 0.16 },
      { limiteInferior: 155229.81, cuotaFija: 14194.54, tasaExcedente: 0.1792 },
      { limiteInferior: 185852.58, cuotaFija: 19682.13, tasaExcedente: 0.2136 },
      { limiteInferior: 374837.89, cuotaFija: 60049.4, tasaExcedente: 0.2352 },
      { limiteInferior: 590796.0, cuotaFija: 110842.74, tasaExcedente: 0.3 },
      { limiteInferior: 1127926.85, cuotaFija: 271981.99, tasaExcedente: 0.32 },
      { limiteInferior: 1503902.47, cuotaFija: 392294.17, tasaExcedente: 0.34 },
      { limiteInferior: 4511707.38, cuotaFija: 1414947.85, tasaExcedente: 0.35 },
    ],
  },
];

/** Select the tarifa whose vigencia covers `fecha` (default: ejercicio match). */
export function tarifaAnualPF(ejercicio: number): TarifaVersionada | null {
  // Exact ejercicio match first; otherwise the most recent table not after it
  // (tarifas roll forward until the SAT publishes an adjustment).
  const exact = TARIFA_ANUAL_PF.find((t) => t.ejercicio === ejercicio);
  if (exact) return exact;
  const prior = TARIFA_ANUAL_PF
    .filter((t) => t.ejercicio < ejercicio)
    .sort((a, b) => b.ejercicio - a.ejercicio)[0];
  return prior ?? null;
}

/**
 * Tarifa "elevada al periodo" para pagos provisionales de PF con actividad
 * empresarial (Art. 106 LISR): la tarifa mensual del Art. 96 sumada por el
 * número de meses del periodo acumulado. Operacionalmente equivale a escalar la
 * tarifa anual por meses/12, lo que evita una segunda tabla de centavos (y su
 * riesgo de divergencia). La diferencia contra la tarifa mensual oficial
 * elevada es sub-peso por redondeo.
 */
export function tarifaPeriodoPF(ejercicio: number, meses: number): { tarifa: TarifaRow[]; base: TarifaVersionada } | null {
  const base = tarifaAnualPF(ejercicio);
  if (!base || meses <= 0) return null;
  const factor = meses / 12;
  const tarifa = base.filas.map((f) => ({
    limiteInferior: f.limiteInferior * factor,
    cuotaFija: f.cuotaFija * factor,
    tasaExcedente: f.tasaExcedente,
  }));
  return { tarifa, base };
}

/** Apply a tarifa to a base: cuotaFija + (base − límiteInferior) × tasa. */
export function aplicarTarifa(base: number, filas: TarifaRow[]): number {
  if (base <= 0 || filas.length === 0) return 0;
  let row = filas[0];
  for (const f of filas) {
    if (base >= f.limiteInferior) row = f;
    else break;
  }
  return row.cuotaFija + (base - row.limiteInferior) * row.tasaExcedente;
}
