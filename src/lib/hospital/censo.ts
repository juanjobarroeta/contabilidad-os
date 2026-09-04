// ─────────────────────────────────────────────────────────────────────────────
// Censo: KPIs puros (ocupación, ingresos/altas del día, estancia promedio,
// día de estancia). La ruta /censo junta las filas; aquí no hay Prisma.
// ─────────────────────────────────────────────────────────────────────────────

import { claveDia, diasEntre } from "./tz";

const MS_DIA = 86_400_000;

/** Día de estancia: el día del ingreso es el 1 (lámina 14: «Día 2 · Dr. Vega»). */
export function diaDeEstancia(fechaIngreso: Date, hoy: Date = new Date()): number {
  return Math.max(1, diasEntre(fechaIngreso, hoy) + 1);
}

/**
 * Estancia promedio en días (un decimal) de un conjunto de episodios: del
 * ingreso al alta, o hasta `hoy` si sigue internado. null sin episodios.
 */
export function estanciaPromedio(
  episodios: Array<{ fechaIngreso: Date; fechaAlta?: Date | null }>,
  hoy: Date = new Date()
): number | null {
  if (episodios.length === 0) return null;
  const total = episodios.reduce((s, e) => {
    const fin = e.fechaAlta ?? hoy;
    return s + Math.max(0, fin.getTime() - e.fechaIngreso.getTime()) / MS_DIA;
  }, 0);
  return Math.round((total / episodios.length) * 10) / 10;
}

export interface CamaCenso {
  estado: string;
  episodio: { fechaIngreso: Date } | null;
}

export interface KpisCenso {
  ocupadas: number;
  camas: number;
  pct: number;
  ingresosHoy: number;
  altasHoy: number;
  estanciaPromedio: number | null;
}

/**
 * KPIs del censo. `ocupadas` cuenta camas con episodio (no el flag OCUPADA,
 * que puede quedar desalineado); ingresos/altas son los episodios cuya fecha
 * cae en el día local de `hoy`.
 */
export function kpisCenso(args: {
  camas: CamaCenso[];
  ingresos: Array<{ fechaIngreso: Date }>;
  altas: Array<{ fechaAlta: Date | null }>;
  estancias: Array<{ fechaIngreso: Date; fechaAlta?: Date | null }>;
  hoy?: Date;
}): KpisCenso {
  const hoy = args.hoy ?? new Date();
  const dia = claveDia(hoy);
  const camas = args.camas.length;
  const ocupadas = args.camas.filter((c) => c.episodio != null).length;
  return {
    ocupadas,
    camas,
    pct: camas ? Math.round((ocupadas / camas) * 100) : 0,
    ingresosHoy: args.ingresos.filter((e) => claveDia(e.fechaIngreso) === dia).length,
    altasHoy: args.altas.filter((e) => e.fechaAlta && claveDia(e.fechaAlta) === dia).length,
    estanciaPromedio: estanciaPromedio(args.estancias, hoy),
  };
}
