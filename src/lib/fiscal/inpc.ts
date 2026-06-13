// ─────────────────────────────────────────────────────────────────────────────
// INPC — Índice Nacional de Precios al Consumidor (INEGI, base 2018=100).
//
// Lo usa la actualización de la depreciación (Art. 31 LISR) y otros cálculos
// inflacionarios. Versionado/git-tracked como las tarifas; `verificado: false`
// hasta cotejar contra la fuente oficial (INEGI / DOF).
//
// COBERTURA ACTUAL: ene–dic 2016–2025 (años completos) + ene–may 2026 (junio aún
// no lo publica INEGI). Cubre los meses que pide la actualización de pérdidas
// (Art. 57: jul, dic del origen; jun de aplicación) y de la depreciación. Para
// meses no cargados `inpc()` devuelve null y el factor cae a 1.0 (nominal).
// Valores cotejados contra Banxico SIE serie SP1 (redondeo a 3 decimales).
// ─────────────────────────────────────────────────────────────────────────────

export const INPC_VERIFICADO = false;
export const INPC_FUENTE = "INEGI, INPC base 2ª quincena jul-2018 = 100 (histórico 2016-2026)";

// [ene, feb, mar, abr, may, jun, jul, ago, sep, oct, nov, dic]; null = no cargado.
type Fila = (number | null)[];

const INPC: Record<number, Fila> = {
  2016: [89.386, 89.778, 89.910, 89.625, 89.226, 89.324, 89.557, 89.809, 90.358, 90.906, 91.617, 92.039],
  2017: [93.604, 94.145, 94.722, 94.839, 94.725, 94.964, 95.323, 95.794, 96.094, 96.698, 97.695, 98.273],
  2018: [98.795, 99.171, 99.492, 99.155, 98.994, 99.376, 99.909, 100.492, 100.917, 101.440, 102.303, 103.020],
  2019: [103.108, 103.079, 103.476, 103.531, 103.233, 103.299, 103.687, 103.670, 103.942, 104.503, 105.346, 105.934],
  2020: [106.447, 106.889, 106.838, 105.755, 106.162, 106.743, 107.444, 107.867, 108.114, 108.774, 108.856, 109.271],
  2021: [110.210, 110.907, 111.824, 112.190, 112.419, 113.018, 113.682, 113.899, 114.601, 115.561, 116.884, 117.308],
  2022: [118.002, 118.981, 120.159, 120.809, 121.022, 122.044, 122.948, 123.803, 124.571, 125.276, 125.997, 126.478],
  2023: [127.336, 128.046, 128.389, 128.363, 128.084, 128.214, 128.832, 129.545, 130.120, 130.609, 131.445, 132.373],
  2024: [133.555, 133.681, 134.065, 134.336, 134.087, 134.594, 136.003, 136.013, 136.080, 136.828, 137.424, 137.949],
  2025: [138.343, 138.726, 139.161, 139.620, 140.012, 140.405, 140.780, 140.867, 141.197, 141.708, 142.645, 143.042],
  2026: [143.588, 144.307, 145.544, 145.831, 145.527, null, null, null, null, null, null, null],
};

/** INPC de un (año, mes 1-12). Null si no está cargado. */
export function inpc(year: number, month: number): number | null {
  const fila = INPC[year];
  if (!fila || month < 1 || month > 12) return null;
  return fila[month - 1];
}

/** Último (año, mes) con INPC cargado — para el chequeo de cobertura de datos. */
export function coberturaInpc(): { year: number; month: number } | null {
  let best: { year: number; month: number } | null = null;
  for (const [yStr, fila] of Object.entries(INPC)) {
    const y = Number(yStr);
    for (let m = 12; m >= 1; m--) {
      if (fila[m - 1] != null) {
        if (!best || y > best.year || (y === best.year && m > best.month)) best = { year: y, month: m };
        break;
      }
    }
  }
  return best;
}

/** Todos los INPC cargados como lista — para cotejar contra la fuente (INEGI). */
export function inpcCargados(): { year: number; month: number; valor: number }[] {
  const out: { year: number; month: number; valor: number }[] = [];
  for (const [yStr, fila] of Object.entries(INPC)) {
    const y = Number(yStr);
    fila.forEach((v, i) => {
      if (v != null) out.push({ year: y, month: i + 1, valor: v });
    });
  }
  return out;
}

export interface FactorActualizacion {
  /** Factor INPC (num/den), 4 decimales. 1 cuando no se puede actualizar. */
  factor: number;
  /** True cuando ambos INPC estaban disponibles y el factor es real. */
  completo: boolean;
  /** Mes/año del numerador y denominador, para el papel de trabajo. */
  numerador?: { year: number; month: number; inpc: number };
  denominador?: { year: number; month: number; inpc: number };
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Factor de actualización de la depreciación (Art. 31 LISR):
 *   INPC(último mes de la 1ª mitad del periodo de uso en el ejercicio)
 *   ÷ INPC(mes de adquisición)
 *
 * `startMonthIndex` (0-11) y `mesesUso` describen el periodo de uso DENTRO del
 * ejercicio (ya calculados por la depreciación). Si el nº de meses es impar, el
 * último mes de la 1ª mitad es el inmediato anterior a la mitad (Art. 31).
 * Devuelve factor 1 / completo=false cuando falta algún INPC (→ nominal).
 */
export function factorActualizacionDepreciacion(args: {
  fechaAdquisicion: Date;
  ejercicio: number;
  startMonthIndex: number; // mes de inicio de uso dentro del ejercicio (0=ene)
  mesesUso: number;
}): FactorActualizacion {
  const { fechaAdquisicion, ejercicio, startMonthIndex, mesesUso } = args;
  if (mesesUso < 2) return { factor: 1, completo: true }; // periodo mínimo → ~1

  const mesesPrimeraMitad = mesesUso % 2 === 0 ? mesesUso / 2 : Math.floor(mesesUso / 2);
  const ultimoMesIdx = startMonthIndex + mesesPrimeraMitad - 1; // 0-11
  const numMonth = ultimoMesIdx + 1;

  const adqYear = fechaAdquisicion.getFullYear();
  const adqMonth = fechaAdquisicion.getMonth() + 1;

  const num = inpc(ejercicio, numMonth);
  const den = inpc(adqYear, adqMonth);
  if (num == null || den == null || den === 0) return { factor: 1, completo: false };

  return {
    factor: r4(num / den),
    completo: true,
    numerador: { year: ejercicio, month: numMonth, inpc: num },
    denominador: { year: adqYear, month: adqMonth, inpc: den },
  };
}
