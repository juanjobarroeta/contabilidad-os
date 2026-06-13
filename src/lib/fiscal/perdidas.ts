// ─────────────────────────────────────────────────────────────────────────────
// Pérdidas fiscales — amortización Art. 57 LISR.
//
// Una pérdida fiscal de un ejercicio se amortiza contra la utilidad de los 10
// ejercicios siguientes, ACTUALIZADA por INPC:
//   1) Primera actualización (en el ejercicio en que ocurrió): factor =
//      INPC(dic) / INPC(jul)  — primer mes de la 2ª mitad → último mes del año.
//   2) Cada ejercicio en que se aplica: factor =
//      INPC(jun del ejercicio de aplicación) / INPC(mes de la última actualización).
// Se aplican las más antiguas primero (FIFO) y expiran a los 10 ejercicios.
//
// Estas funciones son puras. Cuando falta un INPC (p.ej. dic, aún no cargado en
// el seed) el factor cae a 1 (nominal) y se marca `completo:false` — igual que la
// actualización de la depreciación — para no adivinar. El llamador puede avisar
// "actualización incompleta: falta INPC dic-AAAA".
// ─────────────────────────────────────────────────────────────────────────────

import { inpc } from "./inpc";

export const ANIOS_AMORTIZACION = 10;

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** Estado persistido de una pérdida fiscal (refleja el modelo PerdidaFiscal). */
export interface PerdidaRecord {
  ejercicioOrigen: number;
  montoOriginal: number;
  /** Saldo pendiente, YA actualizado hasta `mesUltimaActualizacion`. */
  saldoActualizado: number;
  /** "YYYY-MM" del mes hasta el que se actualizó `saldoActualizado`. */
  mesUltimaActualizacion: string;
  agotada: boolean;
  /** Último ejercicio en que se aplicó (para idempotencia del guardado). */
  ultimoEjercicioAplicado?: number | null;
}

function parseMes(s: string): { year: number; month: number } {
  const [y, m] = s.split("-").map(Number);
  return { year: y, month: m };
}

/** INPC(hasta) / INPC(desde), 4 decimales. completo=false si falta algún INPC. */
export function factorInpc(
  desde: { year: number; month: number },
  hasta: { year: number; month: number }
): { factor: number; completo: boolean } {
  const a = inpc(hasta.year, hasta.month);
  const b = inpc(desde.year, desde.month);
  if (a == null || b == null || b === 0) return { factor: 1, completo: false };
  return { factor: r4(a / b), completo: true };
}

/** Una pérdida es aplicable en `ejercicio` si es posterior al origen y no expiró. */
export function perdidaVigente(p: { ejercicioOrigen: number }, ejercicio: number): boolean {
  return ejercicio > p.ejercicioOrigen && ejercicio <= p.ejercicioOrigen + ANIOS_AMORTIZACION;
}

/**
 * Primera actualización de una pérdida recién generada (Art. 57): jul→dic del
 * ejercicio de origen. Devuelve el saldo actualizado y el mes de corte (dic).
 */
export function primeraActualizacion(montoOriginal: number, ejercicioOrigen: number): {
  saldoActualizado: number;
  mesUltimaActualizacion: string;
  factor: number;
  completo: boolean;
} {
  const f = factorInpc({ year: ejercicioOrigen, month: 7 }, { year: ejercicioOrigen, month: 12 });
  return {
    saldoActualizado: r2(montoOriginal * f.factor),
    mesUltimaActualizacion: `${ejercicioOrigen}-12`,
    factor: f.factor,
    completo: f.completo,
  };
}

/** Actualiza un saldo desde su última actualización → junio del ejercicio de aplicación. */
function actualizarAJunio(p: PerdidaRecord, ejercicio: number) {
  const f = factorInpc(parseMes(p.mesUltimaActualizacion), { year: ejercicio, month: 6 });
  return { saldoActualizado: r2(p.saldoActualizado * f.factor), factor: f.factor, completo: f.completo };
}

export interface PerdidaDisponible {
  ejercicioOrigen: number;
  saldoPrevio: number;
  factorActualizacion: number;
  saldoActualizado: number;
  mesActualizado: string;
  actualizacionCompleta: boolean;
  expira: number;
}

/**
 * Pérdidas disponibles (actualizadas a junio de `ejercicio`) para amortizar,
 * sin aplicar todavía — para mostrar en la declaración y alimentar el cálculo.
 */
export function perdidasDisponibles(perdidas: PerdidaRecord[], ejercicio: number): {
  total: number;
  detalles: PerdidaDisponible[];
  algunaIncompleta: boolean;
} {
  const vigentes = perdidas
    .filter((p) => !p.agotada && p.saldoActualizado > 0 && perdidaVigente(p, ejercicio))
    .sort((a, b) => a.ejercicioOrigen - b.ejercicioOrigen);
  let total = 0;
  let algunaIncompleta = false;
  const detalles = vigentes.map((p) => {
    const act = actualizarAJunio(p, ejercicio);
    if (!act.completo) algunaIncompleta = true;
    total = r2(total + act.saldoActualizado);
    return {
      ejercicioOrigen: p.ejercicioOrigen,
      saldoPrevio: p.saldoActualizado,
      factorActualizacion: act.factor,
      saldoActualizado: act.saldoActualizado,
      mesActualizado: `${ejercicio}-06`,
      actualizacionCompleta: act.completo,
      expira: p.ejercicioOrigen + ANIOS_AMORTIZACION,
    };
  });
  return { total: r2(total), detalles, algunaIncompleta };
}

export interface AplicacionDetalle extends PerdidaDisponible {
  aplicado: number;
  saldoRestante: number;
}

export interface AplicacionResultado {
  totalDisponible: number;
  totalAplicado: number;
  utilidadDisponible: number;
  detalles: AplicacionDetalle[];
  /** Estado nuevo de cada pérdida tocada, para persistir. */
  saldosNuevos: PerdidaRecord[];
  algunaIncompleta: boolean;
}

/**
 * Aplica pérdidas FIFO (más antiguas primero) contra la utilidad de `ejercicio`,
 * actualizando cada saldo a junio. Devuelve cuánto se aplicó y el estado nuevo de
 * cada pérdida (saldo restante, mes y agotada) para persistir en el ledger.
 */
export function aplicarPerdidas(
  perdidas: PerdidaRecord[],
  utilidadDisponible: number,
  ejercicio: number
): AplicacionResultado {
  const vigentes = perdidas
    .filter((p) => !p.agotada && p.saldoActualizado > 0 && perdidaVigente(p, ejercicio))
    .sort((a, b) => a.ejercicioOrigen - b.ejercicioOrigen);

  let restante = Math.max(0, r2(utilidadDisponible));
  let totalDisponible = 0;
  let algunaIncompleta = false;
  const detalles: AplicacionDetalle[] = [];
  const saldosNuevos: PerdidaRecord[] = [];

  for (const p of vigentes) {
    const act = actualizarAJunio(p, ejercicio);
    if (!act.completo) algunaIncompleta = true;
    totalDisponible = r2(totalDisponible + act.saldoActualizado);
    const aplicado = r2(Math.min(act.saldoActualizado, restante));
    restante = r2(restante - aplicado);
    const saldoRestante = r2(act.saldoActualizado - aplicado);
    const mesActualizado = `${ejercicio}-06`;
    detalles.push({
      ejercicioOrigen: p.ejercicioOrigen,
      saldoPrevio: p.saldoActualizado,
      factorActualizacion: act.factor,
      saldoActualizado: act.saldoActualizado,
      mesActualizado,
      actualizacionCompleta: act.completo,
      expira: p.ejercicioOrigen + ANIOS_AMORTIZACION,
      aplicado,
      saldoRestante,
    });
    saldosNuevos.push({
      ejercicioOrigen: p.ejercicioOrigen,
      montoOriginal: p.montoOriginal,
      saldoActualizado: saldoRestante,
      mesUltimaActualizacion: mesActualizado,
      agotada: saldoRestante <= 0,
      ultimoEjercicioAplicado: ejercicio,
    });
  }

  const utilidad = Math.max(0, r2(utilidadDisponible));
  return {
    totalDisponible,
    totalAplicado: r2(utilidad - restante),
    utilidadDisponible: utilidad,
    detalles,
    saldosNuevos,
    algunaIncompleta,
  };
}
