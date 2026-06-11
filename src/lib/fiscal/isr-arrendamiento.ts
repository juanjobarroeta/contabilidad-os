import { tarifaMensualSueldos, aplicarTarifa } from "./tarifas";

// ─────────────────────────────────────────────────────────────────────────────
// ISR pago provisional — Persona Física con ingresos por ARRENDAMIENTO
// (régimen 606, Arts. 114-116 LISR).
//
// Pago provisional MENSUAL standalone (no acumulativo como el 612):
//   ingresos del mes efectivamente cobrados
//   − deducción (Art. 115): opción del contribuyente entre deducciones
//     comprobadas o la "ciega" del 35% de los ingresos (más predial pagado)
//   = base gravable → tarifa MENSUAL del Art. 96
//   − retención 10% cuando el arrendatario es PM (Art. 116 último párrafo)
//
// v1: siempre deducción ciega 35% — es la opción típica del rentista y no
// requiere comprobar gastos del inmueble. NO suma predial (no lo trackeamos).
// El refinamiento (elegir comprobadas cuando convenga + predial) queda anotado.
//
// La tarifa mensual es la publicada en el Anexo 8 (tarifaMensualSueldos): el
// Anexo publica UNA tabla mensual que sirve tanto para sueldos (Art. 96) como
// para los provisionales de arrendamiento (Art. 116) — verificado contra
// Cuadros Permanentes 2026, donde ambas tablas son idénticas.
//
// Pendiente (anotado): opción de pago TRIMESTRAL cuando los ingresos del mes
// no exceden 10 UMA mensuales (Art. 116 tercer párrafo).
// ─────────────────────────────────────────────────────────────────────────────

/** Deducción opcional "ciega" del Art. 115 LISR: 35% de los ingresos. */
export const DEDUCCION_CIEGA_ARRENDAMIENTO = 0.35;

export interface IsrArrendamientoInput {
  ejercicio: number;
  /** Ingresos por arrendamiento efectivamente cobrados en el mes. */
  ingresosCobradosMes: number;
  /** ISR retenido (10%) por arrendatarios PM sobre esos ingresos. */
  retencionesMes?: number;
}

export interface IsrArrendamientoResult {
  ingresos: number;
  /** 35% de los ingresos (Art. 115, opción ciega). */
  deduccionCiega: number;
  baseGravable: number;
  /** Tarifa mensual Art. 96 aplicada a la base. */
  isrCausado: number;
  retenciones: number;
  isrPagar: number;
  /** Vigencia + provenance of the tarifa used, so the caller can flag trust. */
  tarifaEjercicio: number;
  tarifaFuente: string;
  tarifaVerificada: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Compute the monthly arrendamiento provisional ISR. Returns null only when no
 * tarifa is available for the ejercicio (caller should report "no calculado").
 */
export function calcularIsrArrendamientoMensual(
  input: IsrArrendamientoInput
): IsrArrendamientoResult | null {
  const t = tarifaMensualSueldos(input.ejercicio); // tarifa mensual publicada (Anexo 8)
  if (!t) return null;

  const ingresos = Math.max(0, input.ingresosCobradosMes);
  const deduccionCiega = r2(ingresos * DEDUCCION_CIEGA_ARRENDAMIENTO);
  const baseGravable = Math.max(0, r2(ingresos - deduccionCiega));
  const isrCausado = r2(aplicarTarifa(baseGravable, t.tarifa.filas));
  const retenciones = r2(input.retencionesMes ?? 0);
  const isrPagar = Math.max(0, r2(isrCausado - retenciones));

  return {
    ingresos: r2(ingresos),
    deduccionCiega,
    baseGravable,
    isrCausado,
    retenciones,
    isrPagar,
    tarifaEjercicio: t.tarifa.ejercicio,
    tarifaFuente: t.tarifa.fuente,
    // No vigente (roll-forward a tabla superada) cuenta como NO verificada.
    tarifaVerificada: t.vigente && t.tarifa.verificado,
  };
}
