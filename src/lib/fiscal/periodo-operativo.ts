// The monthly fiscal workspace opens on the completed calendar month, not the
// current accounting month. Resolve the calendar in Mexico City explicitly so
// Railway (UTC), a travelling accountant, and a browser in Mexico agree around
// midnight and at the January year boundary.

export const ZONA_FISCAL_MX = "America/Mexico_City";

export interface PeriodoMensual {
  year: number;
  month: number;
  key: string;
}

export interface FechaFiscalMx {
  year: number;
  month: number;
  day: number;
  key: string;
}

/** Calendar date of an instant in the fiscal timezone. */
export function fechaFiscalEnMexico(hoy: Date = new Date()): FechaFiscalMx {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONA_FISCAL_MX,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(hoy);

  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error("No se pudo resolver la fecha fiscal en America/Mexico_City");
  }
  return {
    year,
    month,
    day,
    key: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/** Whole calendar days from `from` to `to`, both in YYYY-MM-DD form. */
export function diasEntreFechasCalendario(from: string, to: string): number {
  const parse = (value: string) => {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) throw new Error(`Fecha calendario inválida: ${value}`);
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/** Completed calendar month used as the default monthly filing/close period. */
export function periodoMensualPorDefecto(hoy: Date = new Date()): PeriodoMensual {
  const current = fechaFiscalEnMexico(hoy);
  const year = current.month === 1 ? current.year - 1 : current.year;
  const month = current.month === 1 ? 12 : current.month - 1;
  return {
    year,
    month,
    key: `${year}-${String(month).padStart(2, "0")}`,
  };
}
