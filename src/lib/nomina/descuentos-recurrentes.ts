// ─────────────────────────────────────────────────────────────────────────────
// Descuentos recurrentes por empleado: FONACOT y pensión alimenticia. Un solo
// módulo puro usado por calc-nomina (corridas) Y por el fallback de
// emit-nomina (timbrado individual sin desglose), para que el recibo y el
// CFDI nunca diverjan.
//
// FONACOT (Ley del Instituto FONACOT; patrón afiliado obligatorio): el
// instituto emite una cédula con la retención MENSUAL del trabajador. Aquí se
// captura ese monto mensual y se prorratea por la periodicidad real de pago
// (quincenal = mitad, semanal = 12/52, etc.). CFDI c_TipoDeduccion 011 —
// "Pago de abonos INFONACOT".
//
// Pensión alimenticia (resolución judicial; el patrón está obligado a retener
// — Art. 110 fracc. V LFT): la orden fija un porcentaje de percepciones, un
// porcentaje del neto (tras deducciones de ley) o un monto fijo mensual.
// CFDI c_TipoDeduccion 007 — "Pensión alimenticia".
//
// ALCANCE DOCUMENTADO (v1): ambas se aplican SOLO en nómina ORDINARIA. Si la
// resolución de pensión alcanza aguinaldo/PTU, capturar el importe de esa
// corrida especial como incidencia DESCUENTO — las órdenes varían demasiado
// para automatizarlo sin leer la resolución.
// ─────────────────────────────────────────────────────────────────────────────

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Fracción del mes que representa un periodo de pago según la periodicidad
 * CFDI (c_PeriodicidadPago). Para periodicidades no mapeadas se aproxima con
 * días/30.4 (mismo promedio mensual que usa el resto del módulo de nómina).
 */
export function factorMensual(periodicidadPago: string, diasPagados: number): number {
  switch (periodicidadPago) {
    case "02": return 12 / 52; // semanal
    case "03": return 12 / 26; // catorcenal
    case "04": return 1 / 2; // quincenal
    case "05": return 1; // mensual
    default:
      return diasPagados / 30.4;
  }
}

export type DescuentosRecurrentesInput = {
  /** Retención MENSUAL de la cédula Fonacot (pesos); null/0 = sin crédito. */
  descuentoFonacot: number | null;
  /** "PCT_TOTAL" | "PCT_NETO" | "PESOS" — null = sin pensión. */
  pensionAlimenticiaTipo: string | null;
  /** Porcentaje (0.30 = 30%) para PCT_*; monto MENSUAL en pesos para PESOS. */
  pensionAlimenticiaValor: number | null;
  periodicidadPago: string;
  diasPagados: number;
  /** Percepciones totales del periodo (base de PCT_TOTAL). */
  totalPercepciones: number;
  /** ISR + IMSS obrero + INFONAVIT del periodo (para la base de PCT_NETO). */
  deduccionesLey: number;
};

export type DescuentosRecurrentes = {
  fonacot: number;
  pensionAlimenticia: number;
};

export function calcularDescuentosRecurrentes(
  i: DescuentosRecurrentesInput
): DescuentosRecurrentes {
  const factor = factorMensual(i.periodicidadPago, i.diasPagados);

  const fonacot =
    i.descuentoFonacot && i.descuentoFonacot > 0 ? r2(i.descuentoFonacot * factor) : 0;

  let pension = 0;
  if (i.pensionAlimenticiaValor && i.pensionAlimenticiaValor > 0) {
    switch (i.pensionAlimenticiaTipo) {
      case "PCT_TOTAL":
        pension = r2(i.totalPercepciones * i.pensionAlimenticiaValor);
        break;
      case "PCT_NETO":
        pension = r2(
          Math.max(0, i.totalPercepciones - i.deduccionesLey) * i.pensionAlimenticiaValor
        );
        break;
      case "PESOS":
        pension = r2(i.pensionAlimenticiaValor * factor);
        break;
    }
  }

  return { fonacot, pensionAlimenticia: pension };
}
