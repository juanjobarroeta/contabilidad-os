// ─────────────────────────────────────────────────────────────────────────────
// Fechas locales del hospital (America/Mexico_City).
//
// El censo, la estancia y los folios se cuentan en días LOCALES: una noche
// «transcurre» cuando el reloj de piso cruza la medianoche, no cuando lo hace
// el de Postgres (UTC). Todo lo que necesite «qué día es» pasa por aquí para
// que el cron de las 06:30 y una lectura a las 23:50 vean el mismo día.
// México dejó el horario de verano en 2022, así que el offset es fijo, pero
// se calcula con Intl igual: si vuelve, esto no se entera.
// ─────────────────────────────────────────────────────────────────────────────

export const TZ_HOSPITAL = "America/Mexico_City";

const MS_DIA = 86_400_000;

const formateador = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ_HOSPITAL,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export type PartesLocales = { y: number; m: number; d: number; h: number; min: number; s: number };

/** Año, mes (1–12), día y hora de `instante` en el reloj de piso. */
export function partesLocales(instante: Date): PartesLocales {
  const p: Record<string, number> = {};
  for (const parte of formateador.formatToParts(instante)) {
    if (parte.type !== "literal") p[parte.type] = Number(parte.value);
  }
  // Intl devuelve "24" para la medianoche en algunos runtimes (hourCycle h24).
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, min: p.minute, s: p.second };
}

/** Clave del día local: "2026-09-03". Es lo que hace idempotente la estancia. */
export function claveDia(instante: Date): string {
  const { y, m, d } = partesLocales(instante);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Instante que corresponde a una hora de pared local. Se resuelve por
 * diferencia: se interpreta la pared como UTC, se mira qué pared local le
 * toca a ese instante y se corrige la distancia. Vale mientras no haya un
 * cambio de horario entre ambos (no lo hay en la Ciudad de México).
 */
export function fechaLocal(y: number, m: number, d: number, h = 0, min = 0, s = 0): Date {
  const supuesto = Date.UTC(y, m - 1, d, h, min, s);
  const p = partesLocales(new Date(supuesto));
  const comoUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return new Date(supuesto - (comoUtc - supuesto));
}

/** Medianoche local del día en que cae `instante`. */
export function inicioDiaLocal(instante: Date): Date {
  const { y, m, d } = partesLocales(instante);
  return fechaLocal(y, m, d);
}

/** Medianoche local del día siguiente al de `instante` (límite exclusivo). */
export function finDiaLocal(instante: Date): Date {
  return sumarDias(inicioDiaLocal(instante), 1);
}

/** Suma días calendario locales a una medianoche local (o a cualquier instante). */
export function sumarDias(instante: Date, dias: number): Date {
  const { y, m, d, h, min, s } = partesLocales(instante);
  const base = Date.UTC(y, m - 1, d + dias, h, min, s);
  const p = new Date(base);
  return fechaLocal(p.getUTCFullYear(), p.getUTCMonth() + 1, p.getUTCDate(), h, min, s);
}

/** Días calendario locales entre dos instantes (b − a); negativo si b < a. */
export function diasEntre(a: Date, b: Date): number {
  const pa = partesLocales(a);
  const pb = partesLocales(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / MS_DIA);
}

/** Primer instante del mes local (y, m) y del siguiente — rango [desde, hasta). */
export function rangoMesLocal(y: number, m: number): { desde: Date; hasta: Date } {
  return { desde: fechaLocal(y, m, 1), hasta: m === 12 ? fechaLocal(y + 1, 1, 1) : fechaLocal(y, m + 1, 1) };
}

const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** «2 sep» — como lo escribe el piso en la descripción del cargo. */
export function diaMesCorto(instante: Date): string {
  const { m, d } = partesLocales(instante);
  return `${d} ${MESES_CORTOS[m - 1]}`;
}

/** «08:20» en hora local. */
export function horaLocal(instante: Date): string {
  const { h, min } = partesLocales(instante);
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}
