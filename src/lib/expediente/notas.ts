import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { esTema, esTipoNota, type FuenteExpediente, type TemaExpediente, type TipoNota } from "./claves";

// ─────────────────────────────────────────────────────────────────────────────
// LAS NOTAS DEL EXPEDIENTE — la bitácora de trabajo de la empresa.
//
// Los hechos dicen qué es cierto; las notas dicen qué se hizo y por qué. La
// distinción importa: «esta empresa tiene una terminal Banorte» es un hecho;
// «pedimos el estado de cuenta de la terminal y seguimos sin recibirlo» es una
// nota, y además un PENDIENTE — un compromiso abierto que la siguiente pasada
// tiene que leer antes de ponerse a buscar problemas nuevos.
//
// Sin los pendientes, cada corrida empieza de cero: vuelve a encontrar lo mismo,
// vuelve a reportarlo, y el contador aprende a ignorar el reporte. Es el mismo
// mecanismo que hizo inútil el rail con sus «13,778 posibles duplicados».
// ─────────────────────────────────────────────────────────────────────────────

export interface NotaExpediente {
  id: string;
  createdAt: Date;
  autor: FuenteExpediente;
  autorId: string | null;
  tipo: TipoNota;
  tema: TemaExpediente;
  titulo: string;
  cuerpo: string;
  refs: string[];
  /** La forma estructurada, cuando la nota la tiene (el resumen de la pasada). */
  datos: unknown;
  estado: "abierta" | "resuelta";
  resueltaAt: Date | null;
  resueltaPorNotaId: string | null;
}

/** Cuántas notas recientes entran en el bloque del prompt. */
export const MAX_NOTAS_PROMPT = 12;

/** Largo máximo del cuerpo. Una nota es una nota, no un informe. */
export const MAX_CUERPO = 2000;

/** Cuántas referencias se guardan por nota. */
export const MAX_REFS_NOTA = 40;

const SELECT_NOTA = {
  id: true,
  createdAt: true,
  autor: true,
  autorId: true,
  tipo: true,
  tema: true,
  titulo: true,
  cuerpo: true,
  refs: true,
  datos: true,
  estado: true,
  resueltaAt: true,
  resueltaPorNotaId: true,
} satisfies Prisma.ExpedienteNotaSelect;

type FilaNota = Prisma.ExpedienteNotaGetPayload<{ select: typeof SELECT_NOTA }>;

function aNota(r: FilaNota): NotaExpediente {
  return {
    ...r,
    autor: (["motor", "agente", "usuario"].includes(r.autor) ? r.autor : "motor") as FuenteExpediente,
    tipo: (esTipoNota(r.tipo) ? r.tipo : "observacion") as TipoNota,
    tema: (esTema(r.tema) ? r.tema : "general") as TemaExpediente,
    estado: r.estado === "resuelta" ? "resuelta" : "abierta",
  };
}

export interface EntradaNota {
  companyId: string;
  autor?: FuenteExpediente;
  autorId?: string | null;
  tipo: TipoNota;
  tema: TemaExpediente;
  titulo: string;
  cuerpo: string;
  refs?: string[];
  /** La forma estructurada, para lo que la tenga. Sólo metadatos, nunca secretos. */
  datos?: Prisma.InputJsonValue | null;
}

/** Escribe una nota. Devuelve la nota: quien anota suele querer su id. */
export async function anotar(e: EntradaNota): Promise<NotaExpediente> {
  const fila = await prisma.expedienteNota.create({
    data: {
      companyId: e.companyId,
      autor: e.autor ?? "motor",
      autorId: e.autorId ?? null,
      tipo: e.tipo,
      tema: e.tema,
      titulo: e.titulo.slice(0, 200),
      cuerpo: e.cuerpo.length > MAX_CUERPO ? `${e.cuerpo.slice(0, MAX_CUERPO - 1)}…` : e.cuerpo,
      refs: (e.refs ?? []).slice(0, MAX_REFS_NOTA),
      datos: e.datos ?? undefined,
      // Sólo un pendiente tiene algo que cerrar; lo demás nace ya cerrado para
      // que la lista de abiertos sea exactamente la lista de compromisos.
      estado: e.tipo === "pendiente" ? "abierta" : "resuelta",
      resueltaAt: e.tipo === "pendiente" ? null : new Date(),
    },
    select: SELECT_NOTA,
  });
  return aNota(fila);
}

export interface FiltroNotas {
  tema?: TemaExpediente;
  tipo?: TipoNota;
  estado?: "abierta" | "resuelta";
  limite?: number;
}

/** Las notas más recientes, con los filtros de la página. */
export async function notasRecientes(companyId: string, f: FiltroNotas = {}): Promise<NotaExpediente[]> {
  const filas = await prisma.expedienteNota.findMany({
    where: {
      companyId,
      ...(f.tema ? { tema: f.tema } : {}),
      ...(f.tipo ? { tipo: f.tipo } : {}),
      ...(f.estado ? { estado: f.estado } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: f.limite ?? 50,
    select: SELECT_NOTA,
  });
  return filas.map(aNota);
}

/** Los compromisos abiertos, del más viejo al más nuevo: el que más ha esperado va primero. */
export async function pendientesAbiertas(companyId: string, limite = 20): Promise<NotaExpediente[]> {
  const filas = await prisma.expedienteNota.findMany({
    where: { companyId, tipo: "pendiente", estado: "abierta" },
    orderBy: { createdAt: "asc" },
    take: limite,
    select: SELECT_NOTA,
  });
  return filas.map(aNota);
}

/**
 * Cierra un pendiente, opcionalmente enlazando la nota que lo resolvió.
 *
 * El enlace no es adorno: un pendiente que se cierra sin decir por qué es
 * indistinguible de uno que alguien silenció.
 */
export async function resolverNota(
  companyId: string,
  notaId: string,
  opts: { porNotaId?: string | null; cuando?: Date } = {},
): Promise<NotaExpediente | null> {
  const r = await prisma.expedienteNota.updateMany({
    where: { id: notaId, companyId, estado: "abierta" },
    data: {
      estado: "resuelta",
      resueltaAt: opts.cuando ?? new Date(),
      resueltaPorNotaId: opts.porNotaId ?? null,
    },
  });
  if (r.count === 0) return null;
  const fila = await prisma.expedienteNota.findUnique({ where: { id: notaId }, select: SELECT_NOTA });
  return fila ? aNota(fila) : null;
}

/** Reabre un pendiente que se cerró de más. */
export async function reabrirNota(companyId: string, notaId: string): Promise<NotaExpediente | null> {
  const r = await prisma.expedienteNota.updateMany({
    where: { id: notaId, companyId, tipo: "pendiente" },
    data: { estado: "abierta", resueltaAt: null, resueltaPorNotaId: null },
  });
  if (r.count === 0) return null;
  const fila = await prisma.expedienteNota.findUnique({ where: { id: notaId }, select: SELECT_NOTA });
  return fila ? aNota(fila) : null;
}

// ── La memoria del copiloto ────────────────────────────────────────────────
// «Lo que recuerdo» en el chat son las notas que el copiloto escribió desde la
// app: llevan `datos.origen = "copiloto"` (y la conversación de la que salen).
// Olvidar una es BORRARLA, y sólo se pueden borrar ésas: el resto de la
// bitácora es el rastro del trabajo y no se toca desde el chat.

export const ORIGEN_COPILOTO = "copiloto";

/** Las notas que el copiloto guardó desde el chat, más nuevas primero. */
export async function notasDelCopiloto(companyId: string, limite = 30): Promise<NotaExpediente[]> {
  const filas = await prisma.expedienteNota.findMany({
    where: { companyId, datos: { path: ["origen"], equals: ORIGEN_COPILOTO } },
    orderBy: { createdAt: "desc" },
    take: limite,
    select: SELECT_NOTA,
  });
  return filas.map(aNota);
}

/** Olvida una nota del copiloto. false si no existe o no es del copiloto. */
export async function olvidarNotaDelCopiloto(companyId: string, notaId: string): Promise<boolean> {
  const r = await prisma.expedienteNota.deleteMany({
    where: { id: notaId, companyId, datos: { path: ["origen"], equals: ORIGEN_COPILOTO } },
  });
  return r.count > 0;
}

/** De una lista de notas, la conversación del copiloto de la que salió cada una. */
export function conversacionDeNota(n: Pick<NotaExpediente, "datos">): string | null {
  const d = n.datos as { origen?: unknown; conversationId?: unknown } | null;
  return d && d.origen === ORIGEN_COPILOTO && typeof d.conversationId === "string" ? d.conversationId : null;
}
