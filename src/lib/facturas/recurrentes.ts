// ─────────────────────────────────────────────────────────────────────────────
// Calendario de las facturas recurrentes.
//
// Módulo PURO: decide CUÁNDO toca emitir y cuál es la siguiente fecha, sin
// tocar BD ni red. Lo consumen el cron de generación y la lista de /facturas.
//
// Una recurrente NO timbra: genera una PREFACTURA para revisar. Un CFDI
// timbrado es un documento legal que consume timbre y sólo se deshace
// cancelándolo ante el SAT — no es algo que deba pasar sin que nadie mire. El
// borrador reusa el flujo de prefacturas que ya existe.
// ─────────────────────────────────────────────────────────────────────────────

export type Periodicidad =
  | "SEMANAL"
  | "MENSUAL"
  | "BIMESTRAL"
  | "TRIMESTRAL"
  | "SEMESTRAL"
  | "ANUAL";

export const PERIODICIDAD_LABEL: Record<Periodicidad, string> = {
  SEMANAL: "Cada semana",
  MENSUAL: "Cada mes",
  BIMESTRAL: "Cada 2 meses",
  TRIMESTRAL: "Cada 3 meses",
  SEMESTRAL: "Cada 6 meses",
  ANUAL: "Cada año",
};

/** Meses que avanza cada periodicidad. SEMANAL no está: va por días. */
const MESES: Record<Exclude<Periodicidad, "SEMANAL">, number> = {
  MENSUAL: 1,
  BIMESTRAL: 2,
  TRIMESTRAL: 3,
  SEMESTRAL: 6,
  ANUAL: 12,
};

/** Días del mes indicado (1-12), en UTC. */
export function diasDelMes(year: number, month1a12: number): number {
  return new Date(Date.UTC(year, month1a12, 0)).getUTCDate();
}

/**
 * Siguiente emisión a partir de `actual`.
 *
 * `diaAncla` es el día del mes al que está amarrada la serie, y existe por el
 * caso que rompe todas las implementaciones ingenuas: una renta que se factura
 * el 31. Sumarle un mes a "31 de enero" con aritmética de fechas da "31 de
 * febrero", que JS normaliza al 2 o 3 de marzo — y a partir de ahí la serie
 * queda desfasada PARA SIEMPRE, facturando el día 3. Anclando al 31 y
 * recortando al último día de cada mes, febrero cae 28 (o 29) y marzo vuelve al
 * 31, que es lo que el contrato dice.
 *
 * En SEMANAL el ancla no aplica: son 7 días exactos.
 */
export function siguienteEmision(actual: Date, p: Periodicidad, diaAncla: number): Date {
  if (p === "SEMANAL") {
    return new Date(actual.getTime() + 7 * 24 * 60 * 60 * 1000);
  }

  const salto = MESES[p];
  // getUTCMonth() es 0-11; +salto puede pasarse de 11 y Date.UTC ya rueda el año.
  const y = actual.getUTCFullYear();
  const m = actual.getUTCMonth() + salto;

  // Normaliza año/mes para poder medir el largo del mes destino.
  const destino = new Date(Date.UTC(y, m, 1));
  const yy = destino.getUTCFullYear();
  const mm = destino.getUTCMonth() + 1; // 1-12

  const dia = Math.min(Math.max(diaAncla, 1), diasDelMes(yy, mm));
  return new Date(Date.UTC(yy, mm - 1, dia));
}

export type EstadoRecurrente = {
  activa: boolean;
  proximaEmision: Date;
  /** Opcional: después de esta fecha la serie deja de generar. */
  fin?: Date | null;
};

/**
 * ¿Toca generar hoy? Sólo si la serie está activa, ya llegó su fecha y no pasó
 * su fin. Se compara por INSTANTE: `proximaEmision` se guarda a medianoche UTC,
 * así que cualquier hora del día en que corre el cron ya la supera.
 */
export function debeGenerar(r: EstadoRecurrente, hoy: Date): boolean {
  if (!r.activa) return false;
  if (r.proximaEmision.getTime() > hoy.getTime()) return false;
  if (r.fin && r.fin.getTime() < r.proximaEmision.getTime()) return false;
  return true;
}

/**
 * Avanza la serie UNA sola vez por corrida, aunque venga muy atrasada.
 *
 * Si el cron no corrió en semanas, generar de golpe las prefacturas perdidas
 * inundaría la bandeja con borradores que nadie pidió en ese momento. Avanzando
 * de una en una, el cron diario se pone al corriente solo —una prefactura por
 * día hasta alcanzar el presente— y quien revisa las ve llegar a un ritmo que
 * puede atender.
 */
export function avanzar(r: EstadoRecurrente, p: Periodicidad, diaAncla: number): Date {
  return siguienteEmision(r.proximaEmision, p, diaAncla);
}

/** "Cada mes · próxima el 31 de marzo" — el renglón de la lista. */
export function describirCadencia(p: Periodicidad, proxima: Date, activa: boolean): string {
  if (!activa) return `${PERIODICIDAD_LABEL[p]} · en pausa`;
  return `${PERIODICIDAD_LABEL[p]} · próxima el ${formatoFecha(proxima)}`;
}

const MESES_NOMBRE = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

export function formatoFecha(d: Date): string {
  return `${d.getUTCDate()} de ${MESES_NOMBRE[d.getUTCMonth()]}`;
}
