/**
 * Cálculo de la raya semanal desde la asistencia (puro: sin BD).
 *
 * Cada trabajador se paga por DÍA (tarifa = jornal de `horasJornada` horas)
 * o por HORA. Las horas extra se pagan al doble de la hora normal (LFT art.
 * 67). Un día de medio turno cuenta proporcional: 4 h de una jornada de 8 h
 * es medio jornal.
 *
 * La raya de una cuadrilla suma los jornales netos de sus miembros (menos
 * anticipos/descuentos) más el destajo de la semana: total = jornales +
 * destajo. Ese total es el que se autoriza, se paga y va al costo de la obra.
 */

export type TipoPago = "DIA" | "HORA";

export const FACTOR_HORA_EXTRA = 2;

const round2 = (n: number) => Math.round(n * 100) / 100;

export type TarifaTrabajador = {
  tipoPago: TipoPago;
  tarifa: number;
  horasJornada: number;
};

export type DiaAsistencia = { horas: number; horasExtra: number };

/** Precio de una hora normal para este trabajador. */
export function precioHora(t: TarifaTrabajador): number {
  if (t.tipoPago === "HORA") return t.tarifa;
  return t.horasJornada > 0 ? t.tarifa / t.horasJornada : 0;
}

export type DetalleCalculado = {
  diasTrabajados: number;
  horas: number;
  horasExtra: number;
  bruto: number;
  descuento: number;
  importe: number;
};

/**
 * Jornal de un trabajador en la semana. `descuento` (anticipos) se topa al
 * bruto: un anticipo mayor que la semana deja el pago en 0, no negativo.
 */
export function calcularDetalle(
  t: TarifaTrabajador,
  dias: DiaAsistencia[],
  descuento = 0
): DetalleCalculado {
  const horas = dias.reduce((a, d) => a + (d.horas || 0), 0);
  const horasExtra = dias.reduce((a, d) => a + (d.horasExtra || 0), 0);
  const diasTrabajados = dias.filter((d) => (d.horas || 0) > 0 || (d.horasExtra || 0) > 0).length;
  const ph = precioHora(t);
  const bruto = round2(horas * ph + horasExtra * ph * FACTOR_HORA_EXTRA);
  const desc = round2(Math.min(Math.max(descuento, 0), bruto));
  return {
    diasTrabajados,
    horas,
    horasExtra,
    bruto,
    descuento: desc,
    importe: round2(bruto - desc),
  };
}

/** Totales de la raya: jornales netos + destajo = lo que se paga. */
export function totalesRaya(
  importesJornal: number[],
  totalDestajo: number
): { totalJornales: number; total: number } {
  const totalJornales = round2(importesJornal.reduce((a, n) => a + (n || 0), 0));
  return { totalJornales, total: round2(totalJornales + (totalDestajo || 0)) };
}

// ── Semanas ────────────────────────────────────────────────────────────────
// Las fechas de asistencia son DATE (YYYY-MM-DD, sin hora). La semana va de
// lunes a domingo.

/** "YYYY-MM-DD" → Date a medianoche UTC (como Prisma lee una columna DATE). */
export function fechaDia(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Fecha inválida: ${s}`);
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Fecha inválida: ${s}`);
  return d;
}

export function isoDia(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Lunes (00:00 UTC) de la semana que contiene `d`. */
export function lunesDe(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = x.getUTCDay(); // 0 = domingo
  x.setUTCDate(x.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return x;
}

/** [lunes, siguiente lunes) — rango semiabierto de la semana. */
export function rangoSemana(d: Date): { desde: Date; hasta: Date } {
  const desde = lunesDe(d);
  const hasta = new Date(desde);
  hasta.setUTCDate(hasta.getUTCDate() + 7);
  return { desde, hasta };
}
