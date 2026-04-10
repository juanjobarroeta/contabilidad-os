// ─── Infonavit Deduction ─────────────────────────────────────────────────────
// Calculates the Infonavit housing credit deduction from employee payroll.
// Three discount types per INFONAVIT guidelines:
//   PCT_SBC: percentage of SBC × dias
//   VSM: number of veces salario mínimo (UMA) × dias
//   PESOS: fixed peso amount per period

import { UMA_DIARIO } from "./constants";

export type InfonavitCalcInput = {
  tipoDescuento: string | null; // "PCT_SBC" | "VSM" | "PESOS" | null
  descuentoInfonavit: number | null; // rate, VSM count, or peso amount
  salarioBaseCotizacion: number; // SBC diario
  diasPagados: number;
};

export function calcularInfonavit(input: InfonavitCalcInput): number {
  const { tipoDescuento, descuentoInfonavit, salarioBaseCotizacion, diasPagados } = input;

  if (!tipoDescuento || !descuentoInfonavit || descuentoInfonavit <= 0) return 0;

  let monto = 0;

  switch (tipoDescuento) {
    case "PCT_SBC":
      // Percentage of SBC × days. descuentoInfonavit is e.g. 0.20 for 20%
      monto = salarioBaseCotizacion * diasPagados * descuentoInfonavit;
      break;
    case "VSM":
      // Veces Salario Mínimo. descuentoInfonavit is a multiplier of UMA diario
      monto = UMA_DIARIO * descuentoInfonavit * diasPagados;
      break;
    case "PESOS":
      // Fixed peso amount per period (not per day)
      monto = descuentoInfonavit;
      break;
    default:
      return 0;
  }

  return Math.round(monto * 100) / 100;
}
