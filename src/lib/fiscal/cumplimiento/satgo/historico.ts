// ─────────────────────────────────────────────────────────────────────────────
// Historial de declaraciones MENSUALES de una empresa, por EJERCICIO.
//
// La agenda del SAT (lib/agenda-sat) vigila los tres meses recientes; esto
// trae lo de antes, desde el inicio de operaciones hasta `satBackfillYears`
// años atrás, igual que el backfill de CFDIs. Se pide por ejercicio completo
// (`decfiel … mes=0`: un ZIP con los doce acuses) — una llamada al SAT por año
// en vez de doce — y `importarDeclaracionesSatGo` sólo parsea (Claude) los
// meses a los que les falta fila, así que repetirlo no cuesta.
//
// La declaración ANUAL va aparte (`decanualfiel`, ver anual.ts): probada en
// vivo para físicas y morales; se pide por ejercicio cerrado que no tenga
// fila con PDF, en la misma corrida.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { SatGoClient, SatGoError } from "./client";
import { importarDeclaracionesSatGo, type ImportacionDeclaracionesSatGo } from "./declaraciones";
import { anualesPendientes, importarAnualSatGo, type AnualResultado } from "./anual";

const TIPOS = ["IVA_MENSUAL", "ISR_PROVISIONAL", "IEPS_MENSUAL"] as const;

export interface EjercicioPendiente {
  ejercicio: number;
  /** Meses cerrados del ejercicio (dentro del rango de la empresa). */
  meses: number;
  /** Meses con TODAS sus filas obligadas presentes. */
  completos: number;
}

/**
 * Ejercicios del rango de la empresa con algún mes cerrado al que le falte
 * una fila obligada, del más reciente al más viejo. PURA sobre lo que se le
 * pasa (la consulta vive en ejerciciosPendientes).
 */
export function ejerciciosConHuecos(args: {
  hoy: Date;
  anios: number;
  inicio: Date | null;
  obligadas: ReadonlySet<string>;
  /** «tipo:YYYY-MM» de las filas existentes. */
  have: ReadonlySet<string>;
}): EjercicioPendiente[] {
  const { hoy, anios, inicio, obligadas, have } = args;
  if (obligadas.size === 0) return [];
  const mesActual = hoy.getFullYear() * 12 + hoy.getMonth(); // índice del mes en curso (no cerrado)
  const primero = Math.max(mesActual - anios * 12, inicio ? inicio.getFullYear() * 12 + inicio.getMonth() : -Infinity);
  const porEjercicio = new Map<number, EjercicioPendiente>();
  for (let idx = mesActual - 1; idx >= primero; idx--) {
    const ejercicio = Math.floor(idx / 12);
    const mes = (idx % 12) + 1;
    const periodo = `${ejercicio}-${String(mes).padStart(2, "0")}`;
    const e = porEjercicio.get(ejercicio) ?? { ejercicio, meses: 0, completos: 0 };
    e.meses++;
    if ([...obligadas].every((t) => have.has(`${t}:${periodo}`))) e.completos++;
    porEjercicio.set(ejercicio, e);
  }
  return [...porEjercicio.values()].filter((e) => e.completos < e.meses).sort((a, b) => b.ejercicio - a.ejercicio);
}

export async function ejerciciosPendientes(companyId: string, hoy = new Date()): Promise<EjercicioPendiente[]> {
  const c = await prisma.company.findUnique({
    where: { id: companyId },
    select: { satBackfillYears: true, fechaInicioOperaciones: true, obligations: { where: { activa: true }, select: { tipo: true } } },
  });
  if (!c) return [];
  const obligadas = new Set(c.obligations.map((o) => o.tipo).filter((t) => (TIPOS as readonly string[]).includes(t)));
  const filas = await prisma.taxDeclaration.findMany({
    where: { companyId, tipo: { in: [...TIPOS] } },
    select: { tipo: true, periodo: true },
  });
  return ejerciciosConHuecos({
    hoy,
    anios: Math.max(1, c.satBackfillYears),
    inicio: c.fechaInicioOperaciones,
    obligadas,
    have: new Set(filas.map((f) => `${f.tipo}:${f.periodo}`)),
  });
}

export interface HistoricoResultado {
  companyId: string;
  pendientesAntes: number;
  ejercicios: Array<{ ejercicio: number } & Pick<ImportacionDeclaracionesSatGo, "estado" | "archivos" | "acusesParseados" | "creadas" | "pdfAdjuntados" | "error">>;
  anuales: AnualResultado[];
  /** SatGo rechazó por suscripción (403): no tiene caso seguir con nadie. */
  sinSuscripcion?: boolean;
}

export function esErrorDeSuscripcion(e: unknown): boolean {
  if (e instanceof SatGoError) return e.status === 403 && /suscripci/i.test(e.message);
  return typeof e === "string" && /403/.test(e) && /suscripci/i.test(e);
}

/** Trae hasta `maxEjercicios` ejercicios con huecos, del más reciente al más viejo. */
export async function importarHistoricoDeclaraciones(
  companyId: string,
  opts: { maxEjercicios?: number; client?: SatGoClient; hoy?: Date } = {},
): Promise<HistoricoResultado> {
  const hoy = opts.hoy ?? new Date();
  const pendientes = await ejerciciosPendientes(companyId, hoy);
  const out: HistoricoResultado = { companyId, pendientesAntes: pendientes.length, ejercicios: [], anuales: [] };
  const client = opts.client ?? new SatGoClient();
  for (const p of pendientes.slice(0, opts.maxEjercicios ?? 2)) {
    const r = await importarDeclaracionesSatGo(companyId, { ejercicio: p.ejercicio, mes: 0 }, { client });
    out.ejercicios.push({ ejercicio: p.ejercicio, estado: r.estado, archivos: r.archivos, acusesParseados: r.acusesParseados, creadas: r.creadas, pdfAdjuntados: r.pdfAdjuntados, error: r.error });
    if (r.estado === "error" && esErrorDeSuscripcion(r.error ?? "")) {
      out.sinSuscripcion = true;
      break;
    }
  }
  if (out.sinSuscripcion) return out;
  // Anuales: los ejercicios cerrados sin fila con PDF, mismos topes por corrida.
  for (const ejercicio of (await anualesPendientes(companyId, hoy)).slice(0, opts.maxEjercicios ?? 2)) {
    const a = await importarAnualSatGo(companyId, ejercicio, { client });
    out.anuales.push(a);
    if (a.estado === "error" && esErrorDeSuscripcion(a.error ?? "")) { out.sinSuscripcion = true; break; }
  }
  return out;
}
