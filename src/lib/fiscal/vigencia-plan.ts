// ─────────────────────────────────────────────────────────────────────────────
// Planeación del barrido de vigencia — la parte que decide QUÉ verificar y de
// QUIÉN, separada del fetch (convención del repo: motores puros + capa de I/O).
//
// El barrido original era un cursor GLOBAL sobre todas las facturas: con pocas
// empresas convergía, pero el tiempo que una empresa espera su turno crece con
// el tamaño de TODO el portafolio. Con miles de clientes, una empresa nueva
// podía esperar meses — y ese fue el reporte real (73% del portafolio
// verificado, 0% de una empresa recién onboardeada).
//
// El rediseño se apoya en dos ideas:
//
//   1. REPARTO POR EMPRESA. Cada corrida atiende a un puñado de empresas (las
//      de barrido más antiguo) y a cada una le da una rebanada del cupo. Así la
//      espera de una empresa depende del número de EMPRESAS, no del número de
//      facturas del portafolio — y es acotada y predecible.
//
//   2. TRABAJO QUE SE SELLA. Por el CFF desde 2022 un CFDI sólo puede
//      cancelarse hasta la anual de su ejercicio. Una factura ya verificada y
//      FUERA de esa ventana no puede cambiar nunca más: se verifica una vez y
//      queda sellada. El trabajo RECURRENTE es sólo la ventana legal vigente,
//      no el archivo histórico completo.
//
// Con eso, el estado estable es O(empresas × facturas de la ventana) en vez de
// O(todas las facturas de la historia).
// ─────────────────────────────────────────────────────────────────────────────

import { mesesVentanaCancelable } from "@/lib/sat-cancelaciones";

/** Cupo mínimo por empresa en una corrida: por debajo de esto el viaje no vale
 *  la pena (una empresa atendida con 2 facturas casi no avanza). */
export const MIN_POR_EMPRESA = 25;

/**
 * Cuántas EMPRESAS atender en una corrida, dado el cupo total. Reparte el cupo
 * en rebanadas de al menos MIN_POR_EMPRESA. Nunca menos de una empresa.
 */
export function empresasDelTurno(cupoTotal: number, minPorEmpresa = MIN_POR_EMPRESA): number {
  return Math.max(1, Math.floor(cupoTotal / Math.max(1, minPorEmpresa)));
}

/**
 * Cupo por empresa cuando se atienden `nEmpresas` en una corrida de `cupoTotal`.
 * Reparte parejo y nunca devuelve 0.
 */
export function cupoPorEmpresa(cupoTotal: number, nEmpresas: number): number {
  if (nEmpresas <= 0) return cupoTotal;
  return Math.max(1, Math.floor(cupoTotal / nEmpresas));
}

/**
 * Inicio de la ventana legal de cancelación a una fecha dada: el primer día del
 * mes más antiguo que todavía puede recibir una cancelación. Todo lo anterior,
 * una vez verificado, queda sellado.
 */
export function inicioVentanaCancelable(hoy: Date): Date {
  const meses = mesesVentanaCancelable(hoy);
  return new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - (meses - 1), 1));
}

/**
 * Estimación de cuánto tarda una empresa en volver a tener turno, en horas.
 * Es la métrica que hay que vigilar al crecer el portafolio: si se dispara,
 * hay que subir el cupo, la concurrencia o la cadencia. `null` sin datos.
 */
export function horasParaSiguienteTurno(opts: {
  empresasTotales: number;
  empresasPorCorrida: number;
  corridasPorDia: number;
}): number | null {
  const { empresasTotales, empresasPorCorrida, corridasPorDia } = opts;
  if (empresasPorCorrida <= 0 || corridasPorDia <= 0) return null;
  const corridasParaDarLaVuelta = Math.ceil(empresasTotales / empresasPorCorrida);
  return (corridasParaDarLaVuelta * 24) / corridasPorDia;
}
