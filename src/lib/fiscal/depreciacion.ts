// ─────────────────────────────────────────────────────────────────────────────
// Depreciación fiscal de inversiones (activo fijo) — Arts. 31, 34, 36 LISR.
//
// Un activo fijo NO se deduce de golpe: se deduce vía DEPRECIACIÓN, aplicando el
// por ciento máximo anual (Art. 34) al Monto Original de la Inversión (MOI),
// proporcional a los meses de uso en el ejercicio, y actualizado por INPC
// (Art. 31). Los automóviles tienen un MOI deducible topado (Art. 36-II).
//
// Módulo PURO y unit-testeable. El factor de actualización INPC es un input
// (default 1.0 = nominal, marcado `sinActualizar`) porque requiere la tabla
// INPC publicada por INEGI — se carga aparte, como las tarifas verificadas.
// ─────────────────────────────────────────────────────────────────────────────

export type TipoActivo =
  | "construccion"
  | "mobiliario"
  | "transporte"
  | "computo"
  | "herramental"
  | "comunicaciones"
  | "maquinaria"
  | "otro";

/** Por ciento máximo anual de deducción por tipo de activo (Art. 34 LISR). */
export const TASA_DEPRECIACION: Record<TipoActivo, { tasa: number; fundamento: string; aprox?: boolean }> = {
  construccion:   { tasa: 0.05, fundamento: "Art. 34-I LISR" },
  mobiliario:     { tasa: 0.10, fundamento: "Art. 34-III LISR" },
  transporte:     { tasa: 0.25, fundamento: "Art. 34-VI LISR" },
  computo:        { tasa: 0.30, fundamento: "Art. 34-VII LISR" },
  herramental:    { tasa: 0.35, fundamento: "Art. 34-XII LISR (dados, troqueles, moldes)" },
  comunicaciones: { tasa: 0.10, fundamento: "Art. 34-XIII/XIV LISR (aprox.)", aprox: true },
  maquinaria:     { tasa: 0.10, fundamento: "Art. 35 LISR (10% general; varía por actividad)", aprox: true },
  otro:           { tasa: 0.10, fundamento: "Art. 34/35 LISR (default conservador)", aprox: true },
};

/** Tope MOI deducible para automóviles (Art. 36-II LISR). */
export const TOPE_AUTOMOVIL = 175000;
export const TOPE_AUTOMOVIL_ELECTRICO = 250000; // eléctricos / híbridos

export interface DepreciacionInput {
  moi: number;
  fechaAdquisicion: Date | string;
  tipo: TipoActivo;
  /** Ejercicio para el que se calcula la deducción. */
  ejercicio: number;
  /** El activo es automóvil (aplica tope Art. 36-II). Pickups de carga: false. */
  esAutomovil?: boolean;
  esElectricoHibrido?: boolean;
  /** Fecha de baja/enajenación (si aplica), para prorratear el último ejercicio. */
  fechaBaja?: Date | string | null;
  /** Depreciación nominal ya tomada en ejercicios anteriores (para topar al MOI). */
  depreciacionAcumuladaPrevia?: number;
  /** Factor de actualización INPC (Art. 31). Default 1.0 (nominal, sin actualizar). */
  factorInpc?: number;
}

export interface DepreciacionResult {
  /** MOI deducible tras aplicar el tope de automóvil. */
  moiDeducible: number;
  topeAplicado: boolean;
  tasaAnual: number;
  fundamento: string;
  /** Meses de uso del activo dentro del ejercicio (Art. 31: desde el mes de uso). */
  mesesUsoEjercicio: number;
  /** MOI deducible × tasa × meses/12, topado al saldo pendiente por deducir. */
  depreciacionNominalEjercicio: number;
  factorActualizacion: number;
  /** Deducción del ejercicio ya actualizada por INPC. */
  depreciacionEjercicio: number;
  /** Saldo pendiente por deducir al cierre del ejercicio (nominal). */
  saldoPendiente: number;
  /** True cuando no se aplicó actualización INPC (factor = 1). */
  sinActualizar: boolean;
  /** True cuando la tasa del tipo es aproximada (no literal de tabla). */
  tasaAproximada: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function toDate(d: Date | string): Date {
  return d instanceof Date ? d : new Date(d);
}

/**
 * Meses de uso del activo dentro del ejercicio. El mes de adquisición cuenta
 * (Art. 31: la deducción inicia en el mes en que se empieza a utilizar). Para
 * el primer ejercicio cuenta de su mes de alta a diciembre; en ejercicios
 * completos posteriores son 12; con baja, hasta el mes anterior a la baja.
 */
export function mesesUsoEnEjercicio(
  fechaAdquisicion: Date | string,
  ejercicio: number,
  fechaBaja?: Date | string | null
): number {
  const adq = toDate(fechaAdquisicion);
  const inicioEjercicio = new Date(ejercicio, 0, 1);
  const finEjercicio = new Date(ejercicio, 11, 31);

  if (adq > finEjercicio) return 0; // adquirido en un ejercicio futuro
  const baja = fechaBaja ? toDate(fechaBaja) : null;
  if (baja && baja < inicioEjercicio) return 0; // dado de baja antes del ejercicio

  // Primer mes de uso dentro del ejercicio.
  const primerMes = adq > inicioEjercicio ? adq.getMonth() : 0;
  // Último mes de uso dentro del ejercicio (al dar de baja se deduce hasta el
  // mes inmediato anterior; si no hay baja, hasta diciembre).
  let ultimoMes = 11;
  if (baja && baja <= finEjercicio) {
    ultimoMes = baja.getMonth() - 1;
    if (baja.getFullYear() < ejercicio) ultimoMes = -1;
  }
  return Math.max(0, ultimoMes - primerMes + 1);
}

/**
 * Calcula la deducción por depreciación de un activo para un ejercicio.
 * Pura; el llamador provee MOI, tipo, fechas y (opcional) el factor INPC.
 */
export function calcularDepreciacionEjercicio(input: DepreciacionInput): DepreciacionResult {
  const { tasa, fundamento, aprox } = TASA_DEPRECIACION[input.tipo] ?? TASA_DEPRECIACION.otro;

  // Tope MOI deducible para automóviles (Art. 36-II). Las camionetas de carga
  // NO son automóvil → sin tope (esAutomovil=false).
  let moiDeducible = input.moi;
  let topeAplicado = false;
  if (input.esAutomovil) {
    const tope = input.esElectricoHibrido ? TOPE_AUTOMOVIL_ELECTRICO : TOPE_AUTOMOVIL;
    if (input.moi > tope) {
      moiDeducible = tope;
      topeAplicado = true;
    }
  }

  const meses = mesesUsoEnEjercicio(input.fechaAdquisicion, input.ejercicio, input.fechaBaja);

  // Deducción anual nominal proporcional, topada al saldo pendiente por deducir.
  const acumPrevia = Math.max(0, input.depreciacionAcumuladaPrevia ?? 0);
  const saldoAntes = Math.max(0, r2(moiDeducible - acumPrevia));
  const nominalSinTope = moiDeducible * tasa * (meses / 12);
  const depreciacionNominalEjercicio = r2(Math.min(nominalSinTope, saldoAntes));

  const factor = input.factorInpc && input.factorInpc > 0 ? input.factorInpc : 1;
  const sinActualizar = factor === 1;
  const depreciacionEjercicio = r2(depreciacionNominalEjercicio * factor);
  const saldoPendiente = r2(Math.max(0, saldoAntes - depreciacionNominalEjercicio));

  return {
    moiDeducible: r2(moiDeducible),
    topeAplicado,
    tasaAnual: tasa,
    fundamento,
    mesesUsoEjercicio: meses,
    depreciacionNominalEjercicio,
    factorActualizacion: factor,
    depreciacionEjercicio,
    saldoPendiente,
    sinActualizar,
    tasaAproximada: !!aprox,
  };
}

/** Mapea el subtipo de inversión del clasificador de CFDI al tipo de activo. */
export function tipoActivoDesdeSubtipo(subtipo: string | null | undefined): TipoActivo {
  switch (subtipo) {
    case "construccion": return "construccion";
    case "mobiliario": return "mobiliario";
    case "transporte": return "transporte";
    case "computo": return "computo";
    case "herramental": return "herramental";
    case "comunicaciones": return "comunicaciones";
    case "maquinaria": return "maquinaria";
    default: return "otro";
  }
}
