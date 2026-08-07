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
// Deducción ciega 35% — la opción típica del rentista, que no exige comprobar
// gastos del inmueble — MÁS el impuesto predial efectivamente pagado, que el
// propio Art. 115 permite sumar a la ciega. Antes se ignoraba el predial, lo
// que sobreestimaba la base y hacía pagar ISR de más.
//
// Pendiente (anotado): comparar contra deducciones COMPROBADAS y elegir la que
// convenga — eso exige un registro de gastos por inmueble que todavía no hay.
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
  /**
   * Impuesto predial EFECTIVAMENTE PAGADO en el mes por los inmuebles
   * arrendados. Art. 115: quien opta por la ciega puede deducirlo ADEMÁS del
   * 35%. Se deduce en el mes de la erogación (el artículo lo refiere al año de
   * calendario; en provisionales el criterio práctico es el mes en que se paga).
   */
  predialPagadoMes?: number;
}

export interface IsrArrendamientoResult {
  ingresos: number;
  /** 35% de los ingresos (Art. 115, opción ciega). */
  deduccionCiega: number;
  /** Predial pagado del mes, deducible ADEMÁS de la ciega (Art. 115). */
  predialPagado: number;
  /** Ciega + predial: lo que realmente se resta de los ingresos. */
  deduccionTotal: number;
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
  const predialPagado = r2(Math.max(0, input.predialPagadoMes ?? 0));
  const deduccionTotal = r2(deduccionCiega + predialPagado);
  // La deducción nunca deja base negativa: un predial alto en un mes flojo
  // agota la base, no genera "pérdida" en el provisional.
  const baseGravable = Math.max(0, r2(ingresos - deduccionTotal));
  const isrCausado = r2(aplicarTarifa(baseGravable, t.tarifa.filas));
  const retenciones = r2(input.retencionesMes ?? 0);
  const isrPagar = Math.max(0, r2(isrCausado - retenciones));

  return {
    ingresos: r2(ingresos),
    deduccionCiega,
    predialPagado,
    deduccionTotal,
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

/**
 * ¿El concepto de un movimiento bancario es una erogación de impuesto predial?
 *
 * Se detecta por texto porque el predial se paga a tesorerías municipales, que
 * rara vez emiten CFDI: el movimiento del banco ES el comprobante de la
 * erogación. Deliberadamente sólo mira la palabra "predial" — un patrón más
 * amplio (tesorería, municipio) arrastraría tenencia, agua y multas, que NO son
 * deducibles junto con la ciega.
 */
export function esErogacionPredial(descripcion: string | null | undefined): boolean {
  return /\bPREDIAL(?:ES)?\b/i.test(descripcion ?? "");
}
