// ─── Pensión Alimenticia ─────────────────────────────────────────────────────
// Descuento recurrente ordenado por resolución judicial (Arts. 110 fracc. V y
// 112 LFT: es de los pocos descuentos al salario expresamente permitidos y no
// tiene los topes de los demás — se aplica en los términos que fije el juez).
//
// Tratamiento fiscal: la pensión NO altera la base gravable de ISR ni el
// SBC/días de cotización IMSS — es una aplicación del salario ya devengado,
// no una exención. Se descuenta DESPUÉS de las deducciones de ley (ISR, IMSS,
// INFONAVIT) y en el CFDI viaja con c_TipoDeduccion 007 (Pensión alimenticia).
//
// Tipos soportados (espejo del patrón de calcularInfonavit):
//   PCT_NETO:   porcentaje del neto del periodo tras deducciones de ley — la
//               forma más común en las resoluciones ("el 20% de sus
//               percepciones netas"). `valor` es decimal (0.20 = 20%).
//   PCT_SBC:    porcentaje del SBC diario × días efectivos del periodo.
//               `valor` es decimal.
//   MONTO_FIJO: monto fijo en pesos POR PERIODO de pago.
//
// El monto se topa al neto disponible: la pensión nunca deja el neto del
// recibo en negativo.

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type PensionAlimenticiaInput = {
  /** "PCT_NETO" | "PCT_SBC" | "MONTO_FIJO" | null (sin pensión). */
  tipo: string | null;
  /** Porcentaje decimal o monto fijo por periodo, según tipo. */
  valor: number | null;
  /** Neto del periodo ANTES de la pensión (percepciones − ISR − IMSS − INFONAVIT). */
  netoAntesPension: number;
  /** SBC diario del empleado (base de PCT_SBC). */
  salarioBaseCotizacion: number;
  /** Días efectivos del periodo (base de PCT_SBC). */
  diasPagados: number;
};

export function calcularPensionAlimenticia(input: PensionAlimenticiaInput): number {
  const { tipo, valor, netoAntesPension, salarioBaseCotizacion, diasPagados } = input;

  if (!tipo || !valor || valor <= 0) return 0;

  let monto = 0;
  switch (tipo) {
    case "PCT_NETO":
      // Porcentaje del neto tras deducciones de ley. Los descuentos internos
      // (préstamos, uniformes) NO reducen la base: la pensión tiene prelación.
      monto = Math.max(0, netoAntesPension) * valor;
      break;
    case "PCT_SBC":
      monto = salarioBaseCotizacion * diasPagados * valor;
      break;
    case "MONTO_FIJO":
      // Monto fijo por periodo de pago (no por día).
      monto = valor;
      break;
    default:
      return 0;
  }

  // Tope: la pensión no puede exceder el neto disponible del periodo.
  return r2(Math.min(monto, Math.max(0, netoAntesPension)));
}
