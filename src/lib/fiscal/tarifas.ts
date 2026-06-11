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
  {
    // 2025 es idéntica a 2024 (no hubo actualización) y la resuelve el registro
    // de 2024 vía vigencia. 2026 SÍ se actualizó por inflación.
    ejercicio: 2026,
    vigenciaDesde: "2026-01-01",
    vigenciaHasta: "2026-12-31",
    fuente: "Art. 152 LISR / Cuadros Permanentes 2026 (Anexo 8 RMF 2026)",
    verificado: true,
    filas: [
      { limiteInferior: 0.01, cuotaFija: 0, tasaExcedente: 0.0192 },
      { limiteInferior: 10135.12, cuotaFija: 194.59, tasaExcedente: 0.064 },
      { limiteInferior: 86022.12, cuotaFija: 5051.37, tasaExcedente: 0.1088 },
      { limiteInferior: 151176.2, cuotaFija: 12140.13, tasaExcedente: 0.16 },
      { limiteInferior: 175735.67, cuotaFija: 16069.64, tasaExcedente: 0.1792 },
      { limiteInferior: 210403.7, cuotaFija: 22282.14, tasaExcedente: 0.2136 },
      { limiteInferior: 424353.98, cuotaFija: 67981.92, tasaExcedente: 0.2352 },
      { limiteInferior: 668840.15, cuotaFija: 125485.07, tasaExcedente: 0.3 },
      { limiteInferior: 1276925.99, cuotaFija: 307910.81, tasaExcedente: 0.32 },
      { limiteInferior: 1702567.98, cuotaFija: 444116.23, tasaExcedente: 0.34 },
      { limiteInferior: 5107703.93, cuotaFija: 1601862.46, tasaExcedente: 0.35 },
    ],
  },
];

// ── Tarifa MENSUAL ISR (Art. 96 LISR) — retención por sueldos y salarios ─────
// La tarifa con la que el patrón retiene ISR a los trabajadores cada mes.
// 2024 cotejada contra Anexo 8 RMF 2024. 2025 fue idéntica (sin actualización).
// 2026 SÍ se actualizó por inflación (igual que la anual) — PENDIENTE de cargar
// desde Cuadros Permanentes 2026: mientras tanto el resolver devuelve la de
// 2024-2025 marcada como NO vigente para que la nómina lo señale.
const TARIFA_MENSUAL_SUELDOS: TarifaVersionada[] = [
  {
    ejercicio: 2024,
    vigenciaDesde: "2024-01-01",
    // Superada a partir de 2026 (actualización por inflación) — el registro
    // 2026 se agrega al verificarlo contra Cuadros Permanentes 2026.
    vigenciaHasta: "2025-12-31",
    fuente: "Art. 96 LISR / Anexo 8 RMF 2024 (DOF 29-dic-2023, fracc. I)",
    verificado: true,
    filas: [
      { limiteInferior: 0.01, cuotaFija: 0, tasaExcedente: 0.0192 },
      { limiteInferior: 746.05, cuotaFija: 14.32, tasaExcedente: 0.064 },
      { limiteInferior: 6332.06, cuotaFija: 371.83, tasaExcedente: 0.1088 },
      { limiteInferior: 11128.02, cuotaFija: 893.63, tasaExcedente: 0.16 },
      { limiteInferior: 12935.83, cuotaFija: 1182.88, tasaExcedente: 0.1792 },
      { limiteInferior: 15487.72, cuotaFija: 1640.18, tasaExcedente: 0.2136 },
      { limiteInferior: 31236.5, cuotaFija: 5004.12, tasaExcedente: 0.2352 },
      { limiteInferior: 49233.01, cuotaFija: 9236.89, tasaExcedente: 0.3 },
      { limiteInferior: 93993.91, cuotaFija: 22665.17, tasaExcedente: 0.32 },
      { limiteInferior: 125325.21, cuotaFija: 32691.18, tasaExcedente: 0.34 },
      { limiteInferior: 375975.62, cuotaFija: 117912.32, tasaExcedente: 0.35 },
    ],
  },
];

/**
 * Tarifa mensual Art. 96 para el ejercicio. `vigente: false` cuando se resolvió
 * por roll-forward a una tabla cuya vigencia ya venció (p.ej. 2026 mientras no
 * se cargue la actualización) — el llamador debe señalarlo, no confiar en silencio.
 */
export function tarifaMensualSueldos(
  ejercicio: number
): { tarifa: TarifaVersionada; vigente: boolean } | null {
  const exact = TARIFA_MENSUAL_SUELDOS.find((t) => t.ejercicio === ejercicio);
  if (exact) return { tarifa: exact, vigente: true };
  const prior = TARIFA_MENSUAL_SUELDOS
    .filter((t) => t.ejercicio < ejercicio)
    .sort((a, b) => b.ejercicio - a.ejercicio)[0];
  if (!prior) return null;
  const vigente =
    prior.vigenciaHasta == null || `${ejercicio}-01-01` <= prior.vigenciaHasta;
  return { tarifa: prior, vigente };
}

// ── Subsidio para el empleo (decreto DOF 01-may-2024) ───────────────────────
// El decreto sustituyó la tabla decreciente 2013-2023 por un monto ÚNICO
// mensual = pct × UMA mensual, sólo para trabajadores cuyo ingreso mensual no
// excede el tope. No es acreditable/devolutivo: sólo reduce el ISR hasta cero.
export interface SubsidioEmpleoVersionado {
  ejercicio: number;
  vigenciaDesde: string;
  vigenciaHasta: string | null;
  fuente: string;
  verificado: boolean;
  /** Porcentaje de la UMA mensual que constituye el subsidio único. */
  pctUmaMensual: number;
  /** Ingreso mensual máximo (total) para tener derecho al subsidio. */
  topeIngresoMensual: number;
}

const SUBSIDIO_EMPLEO: SubsidioEmpleoVersionado[] = [
  {
    ejercicio: 2024,
    vigenciaDesde: "2024-05-01",
    vigenciaHasta: "2024-12-31",
    fuente: "Decreto subsidio para el empleo (DOF 01-may-2024)",
    verificado: true,
    pctUmaMensual: 0.1182,
    topeIngresoMensual: 9081.0,
  },
  {
    // Modificación del decreto para 2025. ⚠️ verificado: false — cotejar pct y
    // tope contra el decreto (DOF 31-dic-2024) / Cuadros Permanentes antes de
    // confiar en una retención real. 2026 resuelve aquí por roll-forward
    // mientras no se cargue el valor 2026 verificado.
    ejercicio: 2025,
    vigenciaDesde: "2025-01-01",
    vigenciaHasta: null,
    fuente: "Decreto subsidio para el empleo, modificación (DOF 31-dic-2024) — SIN COTEJAR",
    verificado: false,
    pctUmaMensual: 0.138,
    topeIngresoMensual: 10171.0,
  },
];

/** Subsidio al empleo vigente para el ejercicio (roll-forward como las tarifas). */
export function subsidioEmpleo(ejercicio: number): SubsidioEmpleoVersionado | null {
  const exact = SUBSIDIO_EMPLEO.find((s) => s.ejercicio === ejercicio);
  if (exact) return exact;
  return (
    SUBSIDIO_EMPLEO
      .filter((s) => s.ejercicio < ejercicio)
      .sort((a, b) => b.ejercicio - a.ejercicio)[0] ?? null
  );
}

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
