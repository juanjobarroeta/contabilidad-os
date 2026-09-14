// ─────────────────────────────────────────────────────────────────────────────
// Pendientes de un caso: quién lo hace, para cuándo y en qué va.
//
// Un caso lo trabaja un equipo: el socio revisa, el pasante junta anexos, el
// abogado redacta. Sin pendientes con dueño, eso vive en WhatsApp. El copiloto
// PROPONE (origen `copiloto`) al cerrar un esquema o leer un acuerdo; asignar
// y cerrar es del abogado.
//
// Lo puro (orden, vencimiento, transiciones válidas) está separado para poder
// probarlo sin base.
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "@/lib/prisma";
import { apuntar, apuntarVarias, type Actor } from "./bitacora";
import { alcance } from "./despacho";

export type EstadoTarea = "por_hacer" | "en_curso" | "en_revision" | "hecha" | "cancelada";
export type PrioridadTarea = "baja" | "normal" | "alta";
export type OrigenTarea = "manual" | "copiloto" | "acuerdo";

export interface Tarea {
  id: string;
  casoId: string;
  titulo: string;
  detalle: string | null;
  estado: EstadoTarea;
  prioridad: PrioridadTarea;
  vence: Date | null;
  asignadoUserId: string | null;
  creadaPorUserId: string;
  documentoId: string | null;
  origen: OrigenTarea;
  hechaAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const ESTADOS: EstadoTarea[] = ["por_hacer", "en_curso", "en_revision", "hecha", "cancelada"];
const ABIERTAS: EstadoTarea[] = ["por_hacer", "en_curso", "en_revision"];

export function esEstado(v: unknown): v is EstadoTarea {
  return typeof v === "string" && (ESTADOS as string[]).includes(v);
}

export function esPrioridad(v: unknown): v is PrioridadTarea {
  return v === "baja" || v === "normal" || v === "alta";
}

/** Una tarea cerrada no vuelve sola: reabrirla es explícito. Puro. */
export function transicionValida(de: EstadoTarea, a: EstadoTarea): boolean {
  if (de === a) return true;
  if (de === "hecha" || de === "cancelada") return a === "por_hacer" || a === "en_curso";
  return true;
}

/** Vencida, hoy, o con días por delante. Puro: la UI pinta con esto. */
export function urgencia(t: Pick<Tarea, "estado" | "vence">, ahora: Date = new Date()): { estado: "sin_fecha" | "vencida" | "hoy" | "proxima" | "lejana" | "cerrada"; dias: number | null } {
  if (t.estado === "hecha" || t.estado === "cancelada") return { estado: "cerrada", dias: null };
  if (!t.vence) return { estado: "sin_fecha", dias: null };
  const dia = 24 * 60 * 60 * 1000;
  const hoy = Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate());
  const v = Date.UTC(t.vence.getUTCFullYear(), t.vence.getUTCMonth(), t.vence.getUTCDate());
  const dias = Math.round((v - hoy) / dia);
  if (dias < 0) return { estado: "vencida", dias };
  if (dias === 0) return { estado: "hoy", dias };
  return { estado: dias <= 3 ? "proxima" : "lejana", dias };
}

/** Primero lo que urge: vencidas, luego por fecha, luego prioridad. Puro. */
export function ordenarTareas<T extends Pick<Tarea, "estado" | "vence" | "prioridad" | "createdAt">>(tareas: T[], ahora: Date = new Date()): T[] {
  const peso = { alta: 0, normal: 1, baja: 2 } as const;
  return [...tareas].sort((a, b) => {
    const ca = a.estado === "hecha" || a.estado === "cancelada" ? 1 : 0;
    const cb = b.estado === "hecha" || b.estado === "cancelada" ? 1 : 0;
    if (ca !== cb) return ca - cb;
    const va = a.vence ? a.vence.getTime() : Infinity;
    const vb = b.vence ? b.vence.getTime() : Infinity;
    if (va !== vb) return va - vb;
    if (peso[a.prioridad] !== peso[b.prioridad]) return peso[a.prioridad] - peso[b.prioridad];
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

function aTarea(f: { estado: string; prioridad: string; origen: string } & Omit<Tarea, "estado" | "prioridad" | "origen">): Tarea {
  return { ...f, estado: (esEstado(f.estado) ? f.estado : "por_hacer") as EstadoTarea, prioridad: (esPrioridad(f.prioridad) ? f.prioridad : "normal") as PrioridadTarea, origen: (f.origen === "copiloto" || f.origen === "acuerdo" ? f.origen : "manual") as OrigenTarea };
}

export interface NuevaTarea {
  titulo: string;
  detalle?: string | null;
  vence?: Date | string | null;
  prioridad?: PrioridadTarea;
  asignadoUserId?: string | null;
  documentoId?: string | null;
  origen?: OrigenTarea;
}

function fecha(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function crearTareas(casoId: string, userId: string, nuevas: NuevaTarea[], actor: Actor): Promise<Tarea[]> {
  const limpias = nuevas.map((t) => ({ ...t, titulo: (t.titulo ?? "").trim().slice(0, 300) })).filter((t) => t.titulo.length > 2).slice(0, 30);
  if (limpias.length === 0) return [];
  const creadas: Tarea[] = [];
  for (const t of limpias) {
    const f = await prisma.juridicoTarea.create({
      data: {
        casoId,
        creadaPorUserId: userId,
        asignadoUserId: t.asignadoUserId ?? null,
        titulo: t.titulo,
        detalle: t.detalle ?? null,
        prioridad: esPrioridad(t.prioridad) ? t.prioridad : "normal",
        vence: fecha(t.vence),
        documentoId: t.documentoId ?? null,
        origen: t.origen ?? "manual",
      },
    });
    creadas.push(aTarea(f));
  }
  await apuntarVarias(creadas.map((t) => ({ casoId, actor, accion: "tarea.creada" as const, entidad: "tarea", entidadId: t.id, resumen: `agregó el pendiente «${t.titulo}»${t.vence ? ` para el ${t.vence.toISOString().slice(0, 10)}` : ""}`, datos: { prioridad: t.prioridad, origen: t.origen } })));
  return creadas;
}

export async function listarTareas(casoId: string, opts: { soloAbiertas?: boolean } = {}): Promise<Tarea[]> {
  const filas = await prisma.juridicoTarea.findMany({ where: { casoId, ...(opts.soloAbiertas ? { estado: { in: ABIERTAS } } : {}) } });
  return ordenarTareas(filas.map(aTarea));
}

/** Lo que le toca a una persona, de todos sus casos. */
export async function misTareas(userId: string, opts: { limite?: number } = {}): Promise<(Tarea & { casoTitulo: string })[]> {
  const filas = await prisma.juridicoTarea.findMany({
    where: { estado: { in: ABIERTAS }, OR: [{ asignadoUserId: userId }, { asignadoUserId: null, caso: await alcance(userId) }] },
    include: { caso: { select: { titulo: true } } },
    take: Math.min(opts.limite ?? 50, 200),
  });
  return ordenarTareas(filas.map((f) => ({ ...aTarea(f), casoTitulo: f.caso.titulo })));
}

export async function actualizarTarea(id: string, userId: string, cambios: Partial<NuevaTarea> & { estado?: EstadoTarea }, actor: Actor): Promise<Tarea> {
  const actual = await prisma.juridicoTarea.findFirst({ where: { id, caso: await alcance(userId) } });
  if (!actual) throw new Error("Tarea no encontrada");
  const previa = aTarea(actual);
  if (cambios.estado && !transicionValida(previa.estado, cambios.estado)) {
    throw new Error(`Una tarea ${previa.estado} no puede pasar a ${cambios.estado}; reábrela primero.`);
  }
  const estado = cambios.estado ?? previa.estado;
  const f = await prisma.juridicoTarea.update({
    where: { id },
    data: {
      ...(cambios.titulo === undefined ? {} : { titulo: cambios.titulo.trim().slice(0, 300) }),
      ...(cambios.detalle === undefined ? {} : { detalle: cambios.detalle }),
      ...(cambios.prioridad === undefined ? {} : { prioridad: esPrioridad(cambios.prioridad) ? cambios.prioridad : "normal" }),
      ...(cambios.vence === undefined ? {} : { vence: fecha(cambios.vence) }),
      ...(cambios.asignadoUserId === undefined ? {} : { asignadoUserId: cambios.asignadoUserId }),
      ...(cambios.estado === undefined ? {} : { estado, hechaAt: estado === "hecha" ? new Date() : null }),
    },
  });
  const t = aTarea(f);
  if (cambios.estado && cambios.estado !== previa.estado) {
    await apuntar({ casoId: t.casoId, actor, accion: "tarea.movida", entidad: "tarea", entidadId: t.id, resumen: `movió «${t.titulo}» de ${previa.estado} a ${t.estado}`, datos: { de: previa.estado, a: t.estado } });
  }
  if (cambios.asignadoUserId !== undefined && cambios.asignadoUserId !== previa.asignadoUserId) {
    await apuntar({ casoId: t.casoId, actor, accion: "tarea.asignada", entidad: "tarea", entidadId: t.id, resumen: `asignó «${t.titulo}»`, datos: { asignadoUserId: t.asignadoUserId } });
  }
  return t;
}

export async function eliminarTarea(id: string, userId: string, actor: Actor): Promise<void> {
  const t = await prisma.juridicoTarea.findFirst({ where: { id, caso: await alcance(userId) }, select: { id: true, casoId: true, titulo: true } });
  if (!t) throw new Error("Tarea no encontrada");
  await prisma.juridicoTarea.delete({ where: { id } });
  await apuntar({ casoId: t.casoId, actor, accion: "tarea.eliminada", entidad: "tarea", entidadId: t.id, resumen: `eliminó el pendiente «${t.titulo}»` });
}
