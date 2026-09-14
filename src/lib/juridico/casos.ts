// ─────────────────────────────────────────────────────────────────────────────
// El caso: listar, abrir, crear, cerrar. La ficha (partes, decisiones) sigue
// viviendo en asuntos.ts —es el mismo registro— y aquí está lo que un despacho
// necesita alrededor: estado, responsable, cliente del directorio, conteos y
// lo que hay que atender.
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "@/lib/prisma";
import { apuntar, type Actor } from "./bitacora";
import { alcance, despachoParaCrear } from "./despacho";
import { urgencia, type Tarea } from "./tareas";

export type EstadoCaso = "abierto" | "en_tramite" | "cerrado";

export function esEstadoCaso(v: unknown): v is EstadoCaso {
  return v === "abierto" || v === "en_tramite" || v === "cerrado";
}

export interface CasoEnLista {
  id: string;
  titulo: string;
  materia: string | null;
  via: string | null;
  autoridad: string | null;
  expediente: string | null;
  entidad: string | null;
  estado: EstadoCaso;
  cliente: string | null;
  clienteId: string | null;
  clienteNombre: string | null;
  responsableUserId: string | null;
  actualizado: Date;
  partes: number;
  documentos: number;
  conversaciones: number;
  tareasAbiertas: number;
  /** Lo más urgente que queda por hacer, si hay algo con fecha. */
  proximoVencimiento: Date | null;
}

const ABIERTAS = ["por_hacer", "en_curso", "en_revision"];

export async function listarCasos(userId: string, opts: { estado?: EstadoCaso; busqueda?: string; limite?: number } = {}): Promise<CasoEnLista[]> {
  const q = (opts.busqueda ?? "").trim();
  const mios = await alcance(userId);
  const filas = await prisma.juridicoCaso.findMany({
    where: {
      ...mios,
      ...(opts.estado ? { estado: opts.estado } : {}),
      ...(q
        ? {
            OR: [
              { titulo: { contains: q, mode: "insensitive" as const } },
              { expediente: { contains: q, mode: "insensitive" as const } },
              { autoridad: { contains: q, mode: "insensitive" as const } },
              { partes: { some: { nombre: { contains: q, mode: "insensitive" as const } } } },
            ],
          }
        : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: Math.min(opts.limite ?? 50, 200),
    select: {
      id: true, titulo: true, materia: true, via: true, autoridad: true, expediente: true, entidad: true,
      estado: true, cliente: true, clienteId: true, responsableUserId: true, updatedAt: true,
      clienteRef: { select: { nombre: true } },
      _count: { select: { partes: true, documentos: true, conversaciones: true } },
      tareas: { where: { estado: { in: ABIERTAS } }, select: { vence: true }, orderBy: { vence: "asc" } },
    },
  });
  return filas.map((f) => ({
    id: f.id,
    titulo: f.titulo,
    materia: f.materia,
    via: f.via,
    autoridad: f.autoridad,
    expediente: f.expediente,
    entidad: f.entidad,
    estado: (esEstadoCaso(f.estado) ? f.estado : "abierto") as EstadoCaso,
    cliente: f.cliente,
    clienteId: f.clienteId,
    clienteNombre: f.clienteRef?.nombre ?? null,
    responsableUserId: f.responsableUserId,
    actualizado: f.updatedAt,
    partes: f._count.partes,
    documentos: f._count.documentos,
    conversaciones: f._count.conversaciones,
    tareasAbiertas: f.tareas.length,
    proximoVencimiento: f.tareas.find((t) => t.vence)?.vence ?? null,
  }));
}

/** Cuántos casos hay en cada estado (para las pestañas de la lista). */
export async function conteoPorEstado(userId: string): Promise<Record<EstadoCaso, number>> {
  const filas = await prisma.juridicoCaso.groupBy({ by: ["estado"], where: await alcance(userId), _count: { _all: true } });
  const out: Record<EstadoCaso, number> = { abierto: 0, en_tramite: 0, cerrado: 0 };
  for (const f of filas) if (esEstadoCaso(f.estado)) out[f.estado] = f._count._all;
  return out;
}

export async function crearCaso(userId: string, datos: { titulo: string; materia?: string | null; via?: string | null; autoridad?: string | null; expediente?: string | null; entidad?: string | null; cliente?: string | null; clienteId?: string | null; objetivo?: string | null }, actor: Actor): Promise<{ id: string }> {
  const titulo = (datos.titulo ?? "").trim().slice(0, 200) || "Caso sin título";
  const c = await prisma.juridicoCaso.create({
    data: {
      userId,
      despachoId: await despachoParaCrear(userId),
      titulo,
      materia: datos.materia ?? null,
      via: datos.via ?? null,
      autoridad: datos.autoridad ?? null,
      expediente: datos.expediente ?? null,
      entidad: datos.entidad ?? null,
      cliente: datos.cliente ?? null,
      clienteId: datos.clienteId ?? null,
      objetivo: datos.objetivo ?? null,
      responsableUserId: actor.userId ?? userId,
    },
    select: { id: true },
  });
  await apuntar({ casoId: c.id, actor, accion: "caso.creado", entidad: "caso", entidadId: c.id, resumen: `abrió el caso «${titulo}»`, datos: { materia: datos.materia, expediente: datos.expediente } });
  return c;
}

export async function cambiarEstadoCaso(id: string, userId: string, estado: EstadoCaso, actor: Actor): Promise<void> {
  const actual = await prisma.juridicoCaso.findFirst({ where: { id, ...(await alcance(userId)) }, select: { estado: true, titulo: true } });
  if (!actual) throw new Error("Caso no encontrado");
  if (actual.estado === estado) return;
  await prisma.juridicoCaso.update({ where: { id }, data: { estado, cerradoAt: estado === "cerrado" ? new Date() : null } });
  await apuntar({
    casoId: id,
    actor,
    accion: estado === "cerrado" ? "caso.cerrado" : actual.estado === "cerrado" ? "caso.reabierto" : "caso.actualizado",
    entidad: "caso",
    entidadId: id,
    resumen: estado === "cerrado" ? `cerró el caso «${actual.titulo}»` : `movió el caso «${actual.titulo}» a ${estado}`,
    datos: { de: actual.estado, a: estado },
  });
}

/** Asigna el caso a alguien del despacho (por ahora, el propio abogado). */
export async function asignarResponsable(id: string, userId: string, responsableUserId: string | null, actor: Actor): Promise<void> {
  const c = await prisma.juridicoCaso.findFirst({ where: { id, ...(await alcance(userId)) }, select: { titulo: true } });
  if (!c) throw new Error("Caso no encontrado");
  await prisma.juridicoCaso.update({ where: { id }, data: { responsableUserId } });
  await apuntar({ casoId: id, actor, accion: "caso.actualizado", entidad: "caso", entidadId: id, resumen: responsableUserId ? `asignó el caso «${c.titulo}»` : `dejó el caso «${c.titulo}» sin responsable`, datos: { responsableUserId } });
}

/** Liga el caso con una ficha del directorio. */
export async function ligarClienteACaso(id: string, userId: string, clienteId: string | null, actor: Actor): Promise<void> {
  const c = await prisma.juridicoCaso.findFirst({ where: { id, ...(await alcance(userId)) }, select: { titulo: true } });
  if (!c) throw new Error("Caso no encontrado");
  if (clienteId) {
    const existe = await prisma.juridicoCliente.findFirst({ where: { id: clienteId, ...(await alcance(userId)) }, select: { id: true, nombre: true } });
    if (!existe) throw new Error("Cliente no encontrado");
    await prisma.juridicoCaso.update({ where: { id }, data: { clienteId } });
    await apuntar({ casoId: id, actor, accion: "cliente.ligado", entidad: "cliente", entidadId: clienteId, resumen: `ligó el caso con ${existe.nombre}`, datos: { clienteId } });
    return;
  }
  await prisma.juridicoCaso.update({ where: { id }, data: { clienteId: null } });
  await apuntar({ casoId: id, actor, accion: "cliente.ligado", entidad: "cliente", entidadId: null, resumen: `quitó el cliente del caso «${c.titulo}»` });
}

/** Mueve una conversación (y sus documentos) a un caso. */
export async function moverConversacionACaso(conversacionId: string, casoId: string, userId: string, actor: Actor): Promise<void> {
  const conv = await prisma.juridicoConversacion.findFirst({ where: { id: conversacionId, userId }, select: { id: true, titulo: true, casoId: true } });
  if (!conv) throw new Error("Conversación no encontrada");
  const caso = await prisma.juridicoCaso.findFirst({ where: { id: casoId, ...(await alcance(userId)) }, select: { id: true, titulo: true } });
  if (!caso) throw new Error("Caso no encontrado");
  await prisma.$transaction([
    prisma.juridicoConversacion.update({ where: { id: conversacionId }, data: { casoId } }),
    prisma.juridicoDocumento.updateMany({ where: { conversacionId }, data: { casoId } }),
  ]);
  await apuntar({ casoId, actor, accion: "caso.actualizado", entidad: "caso", entidadId: casoId, resumen: `movió la conversación «${conv.titulo}» a este caso`, datos: { conversacionId, desdeCasoId: conv.casoId } });
}

/** Lo que hay que atender: tareas vencidas o de hoy, en todos los casos. */
export function loQueUrge(tareas: (Tarea & { casoTitulo?: string })[], ahora: Date = new Date()): (Tarea & { casoTitulo?: string })[] {
  return tareas.filter((t) => {
    const u = urgencia(t, ahora);
    return u.estado === "vencida" || u.estado === "hoy";
  });
}
