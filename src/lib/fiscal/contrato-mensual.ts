import {
  diasEntreFechasCalendario,
  fechaFiscalEnMexico,
  periodoMensualPorDefecto,
  type FechaFiscalMx,
  type PeriodoMensual,
} from "./periodo-operativo";
import { calcularVencimiento, fechaCalendarioIso, type ObligacionConfig } from "../obligaciones";

export const OBLIGACION_FEDERAL_MENSUAL: ObligacionConfig = {
  tipo: "FEDERAL_MENSUAL",
  descripcion: "Declaración federal mensual",
  periodicidad: "MENSUAL",
  diaVencimiento: 17,
};

export interface ContratoMensualFiscal {
  hoy: FechaFiscalMx;
  periodo: PeriodoMensual;
  /** Calendar date, never an instant. */
  fechaLimite: string;
  diasRestantes: number;
  vencida: boolean;
}

/**
 * Shared API contract for the completed monthly period currently being filed.
 * Dashboard, cockpit, satellites and notifications must agree with this value.
 */
export function contratoMensualFiscal(hoy: Date = new Date()): ContratoMensualFiscal {
  const fecha = fechaFiscalEnMexico(hoy);
  const periodo = periodoMensualPorDefecto(hoy);
  const fechaLimite = fechaCalendarioIso(
    calcularVencimiento(OBLIGACION_FEDERAL_MENSUAL, periodo.key),
  );
  const diasRestantes = diasEntreFechasCalendario(fecha.key, fechaLimite);
  return {
    hoy: fecha,
    periodo,
    fechaLimite,
    diasRestantes,
    vencida: diasRestantes < 0,
  };
}
