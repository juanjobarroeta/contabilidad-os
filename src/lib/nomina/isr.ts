// ─────────────────────────────────────────────────────────────────────────────
// ISR retención por sueldos — Tarifa Art. 96 LISR + Subsidio para el Empleo
//
// Las tablas viven en src/lib/fiscal/tarifas.ts (versionadas, con vigencia,
// procedencia y `verificado`), NO inline aquí: son correctness-critical y se
// mantienen por PR revisado. El subsidio usa el mecanismo del decreto
// DOF 01-may-2024 (monto único = pct × UMA mensual hasta un tope de ingreso),
// que sustituyó a la tabla decreciente 2013-2023.
//
// `tarifaVerificada: false` en el resultado significa que la retención se
// calculó con una tabla vencida o sin cotejar (p.ej. tarifa 2026 pendiente de
// Cuadros Permanentes 2026) — el llamador debe señalarlo, no confiar en
// silencio.
// ─────────────────────────────────────────────────────────────────────────────

import { tarifaMensualSueldos, subsidioEmpleo, aplicarTarifa } from "../fiscal/tarifas";
import { UMA_MENSUAL, UMA_MENSUAL_2025, SALARIO_MINIMO_GENERAL, SALARIO_MINIMO_ZLFN } from "./constants";

// Periodicidad → factor para convertir base del periodo a base mensual
// (la tarifa está en mensual; convertimos primero, calculamos, luego dividimos
// proporcionalmente para devolver el ISR del periodo).
const PERIODICIDAD_FACTOR: Record<string, number> = {
  "01": 1 / 7,    // Diario
  "02": 7 / 30.4, // Semanal (~7 días)
  "03": 14 / 30.4,// Catorcenal
  "04": 15 / 30.4,// Quincenal
  "05": 1,        // Mensual
  "06": 2,        // Bimestral
  "07": 4 / 30.4, // Por unidad de obra (≈ semanal)
  "10": 1,        // Decenal — usar mensual como aproximación
  "99": 1,        // Otra
};

export type IsrCalcInput = {
  /** Monto bruto del periodo (sueldo + percepciones gravadas) */
  baseGravable: number;
  /** SAT periodicidad code: "04"=quincenal, "05"=mensual, etc. */
  periodicidadPago: string;
  /** Ejercicio fiscal (año de la fecha de pago). Default: año actual. */
  ejercicio?: number;
  /** Mes de la fecha de pago (1-12). Sólo afecta el subsidio de enero (transitorio). Default: mes actual. */
  mes?: number;
  /** El trabajador labora en la Zona Libre de la Frontera Norte (salario mínimo mayor). Default: false. */
  zonaFrontera?: boolean;
};

export type IsrCalcResult = {
  baseMensual: number;
  isrSegunTarifa: number;
  subsidio: number;
  isrRetenido: number;
  /** True si aplicó la exención por salario mínimo (LISR Art. 96): retención = 0. */
  exentoSalarioMinimo: boolean;
  /** Ejercicio de la tabla efectivamente usada (puede ser anterior por roll-forward). */
  tarifaEjercicio: number;
  /**
   * False cuando la tarifa usada está vencida para el ejercicio (roll-forward
   * a una tabla superada) o el subsidio aplicado no está cotejado.
   */
  tarifaVerificada: boolean;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Calcula el ISR retenido por sueldos para un periodo dado.
 * 1. Convierte la base gravable a equivalente mensual
 * 2. Aplica la tarifa Art. 96 LISR del ejercicio
 * 3. Resta el subsidio para el empleo si el ingreso mensual no excede el tope
 *    (decreto: monto único, no devolutivo — sólo baja el ISR hasta cero)
 * 4. Convierte de vuelta a la proporción del periodo
 */
export function calcularIsrRetenido(input: IsrCalcInput): IsrCalcResult {
  const ejercicio = input.ejercicio ?? new Date().getFullYear();
  const mes = input.mes ?? new Date().getMonth() + 1;
  const factor = PERIODICIDAD_FACTOR[input.periodicidadPago] ?? 1;
  const baseMensual = input.baseGravable / factor;

  const t = tarifaMensualSueldos(ejercicio);
  if (!t) {
    // Sin tabla para el ejercicio (anterior a las versionadas): no retener a
    // ciegas — devolver 0 marcado como NO verificado para que se señale.
    return {
      baseMensual,
      isrSegunTarifa: 0,
      subsidio: 0,
      isrRetenido: 0,
      exentoSalarioMinimo: false,
      tarifaEjercicio: ejercicio,
      tarifaVerificada: false,
    };
  }

  const isrMensual = aplicarTarifa(baseMensual, t.tarifa.filas);

  // Subsidio para el empleo (decreto): monto único mensual cuando el ingreso
  // mensual no excede el tope. Se compara contra la base mensualizada.
  // ENERO (transitorio): la UMA del año entra en vigor el 1-feb (Art. 5 LUMA),
  // así que el decreto fija para enero un pct mayor sobre la UMA del año
  // anterior — se calcula contra la UMA 2025 histórica fija, no la env, para
  // que un recálculo de enero siga siendo exacto después de actualizar la UMA.
  const sub = subsidioEmpleo(ejercicio);
  let subsidioMensual = 0;
  if (sub && baseMensual > 0 && baseMensual <= sub.topeIngresoMensual) {
    subsidioMensual =
      mes === 1 && ejercicio === 2026 && sub.pctUmaMensualEnero != null
        ? r2(sub.pctUmaMensualEnero * UMA_MENSUAL_2025)
        : r2(sub.pctUmaMensual * UMA_MENSUAL);
  }

  // LISR Art. 96, último párrafo: NO se retiene a quien en el mes únicamente
  // percibe el salario mínimo del área geográfica. El tope = salario mínimo del
  // área elevado al mes (mismo factor 30.4 que la base mensual). Deriva del
  // salario mínimo vigente (constante/env SALARIO_MINIMO_*), así que se actualiza
  // solo al actualizar el salario mínimo — una sola fuente de verdad. Lo que
  // exceda el tope (percepciones gravadas extra) sí grava normal.
  const salarioMinimoDiario = input.zonaFrontera ? SALARIO_MINIMO_ZLFN : SALARIO_MINIMO_GENERAL;
  const topeExento = salarioMinimoDiario * 30.4;
  const exentoSalarioMinimo = baseMensual > 0 && baseMensual <= topeExento + 0.01; // +0.01: tolerancia FP en el borde

  const retencionMensual = exentoSalarioMinimo ? 0 : Math.max(0, isrMensual - subsidioMensual);

  // Pro-rata back to the period
  const isrRetenido = r2(retencionMensual * factor);

  return {
    baseMensual,
    isrSegunTarifa: r2(isrMensual * factor),
    subsidio: r2(subsidioMensual * factor),
    isrRetenido,
    exentoSalarioMinimo,
    tarifaEjercicio: t.tarifa.ejercicio,
    tarifaVerificada:
      t.vigente && t.tarifa.verificado && (subsidioMensual === 0 || (sub?.verificado ?? false)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// IMSS calculation moved to src/lib/nomina/imss.ts (v2 — real stepped rates).
// Re-export for backwards compatibility with any callers.
// ─────────────────────────────────────────────────────────────────────────────
export { calcularImss } from "./imss";
export type { ImssCalcResult, ImssDesglose } from "./imss";
