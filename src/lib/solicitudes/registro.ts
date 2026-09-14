import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  esEstadoSolicitud,
  esTipoSolicitud,
  redactarPedido,
  type EstadoSolicitud,
  type OrigenSolicitud,
  type TipoSolicitud,
} from "./claves";

// ─────────────────────────────────────────────────────────────────────────────
// ABRIR, ENSEÑAR Y CERRAR SOLICITUDES.
//
// Una solicitud no es una notificación. Una notificación se lee y desaparece;
// una solicitud queda ABIERTA hasta que llega lo que se pidió, y mientras tanto
// se enseña junto al movimiento que la provocó. Ésa es la diferencia entre
// avisar de un problema y pedir lo que hace falta para resolverlo.
//
// Todo el módulo gira alrededor de `dedupeKey`: el motor vuelve a detectar el
// mismo hueco cada mañana, y sin candado el cliente recibiría el mismo pedido
// veinte veces hasta dejar de leerlos.
// ─────────────────────────────────────────────────────────────────────────────

export interface SolicitudRegistrada {
  id: string;
  createdAt: Date;
  tipo: TipoSolicitud;
  motivo: string;
  refs: string[];
  periodo: string | null;
  origen: OrigenSolicitud;
  estado: EstadoSolicitud;
  canalNotif: string[];
  recibidaAt: Date | null;
  recibidaRef: string | null;
  dedupeKey: string;
}

const SELECT = {
  id: true,
  createdAt: true,
  tipo: true,
  motivo: true,
  refs: true,
  periodo: true,
  origen: true,
  estado: true,
  canalNotif: true,
  recibidaAt: true,
  recibidaRef: true,
  dedupeKey: true,
} satisfies Prisma.SolicitudSelect;

type Fila = Prisma.SolicitudGetPayload<{ select: typeof SELECT }>;

function aSolicitud(r: Fila): SolicitudRegistrada {
  return {
    ...r,
    tipo: (esTipoSolicitud(r.tipo) ? r.tipo : "aclaracion") as TipoSolicitud,
    origen: (["motor", "agente", "usuario"].includes(r.origen) ? r.origen : "motor") as OrigenSolicitud,
    estado: (esEstadoSolicitud(r.estado) ? r.estado : "abierta") as EstadoSolicitud,
  };
}

export interface EntradaSolicitud {
  companyId: string;
  tipo: TipoSolicitud;
  dedupeKey: string;
  refs?: string[];
  periodo?: string | null;
  origen?: OrigenSolicitud;
  /** El detalle del caso. El «qué» y el «para qué» los pone la ficha del tipo. */
  detalle?: string | null;
  /** Motivo ya redactado; si no viene, se arma con la ficha del tipo. */
  motivo?: string;
}

export interface ResultadoApertura {
  solicitud: SolicitudRegistrada;
  /** false cuando ya existía: el llamador no debe volver a avisar al cliente. */
  nueva: boolean;
}

/**
 * Abre una solicitud, o devuelve la que ya existía para ese mismo hueco.
 *
 * Es idempotente por `(companyId, dedupeKey)`, y a propósito NO reabre una
 * cancelada: cancelar es una decisión de una persona («ese mes no lleva
 * terminal, olvídalo») y el motor no debe desautorizarla cada mañana.
 */
export async function abrirSolicitud(e: EntradaSolicitud): Promise<ResultadoApertura> {
  const previa = await prisma.solicitud.findUnique({
    where: { companyId_dedupeKey: { companyId: e.companyId, dedupeKey: e.dedupeKey } },
    select: SELECT,
  });
  if (previa) return { solicitud: aSolicitud(previa), nueva: false };

  const fila = await prisma.solicitud.create({
    data: {
      companyId: e.companyId,
      tipo: e.tipo,
      dedupeKey: e.dedupeKey,
      motivo: e.motivo ?? redactarPedido(e.tipo, { periodo: e.periodo, detalle: e.detalle }),
      refs: (e.refs ?? []).slice(0, 100),
      periodo: e.periodo ?? null,
      origen: e.origen ?? "motor",
    },
    select: SELECT,
  });
  return { solicitud: aSolicitud(fila), nueva: true };
}

/** Las solicitudes abiertas de una empresa, de la más vieja a la más nueva. */
export async function solicitudesAbiertas(companyId: string, limite = 50): Promise<SolicitudRegistrada[]> {
  const filas = await prisma.solicitud.findMany({
    where: { companyId, estado: "abierta" },
    orderBy: { createdAt: "asc" },
    take: limite,
    select: SELECT,
  });
  return filas.map(aSolicitud);
}

/**
 * Las solicitudes abiertas que tocan una entidad concreta.
 *
 * Es la consulta de la mesa: al seleccionar un movimiento, qué se está
 * esperando por él. `refs` es un arreglo de texto, así que `has` usa el índice
 * de la tabla por empresa y filtra en Postgres, no en JS.
 */
export async function solicitudesDeEntidad(companyId: string, entidadId: string): Promise<SolicitudRegistrada[]> {
  const filas = await prisma.solicitud.findMany({
    where: { companyId, estado: "abierta", refs: { has: entidadId } },
    orderBy: { createdAt: "asc" },
    select: SELECT,
  });
  return filas.map(aSolicitud);
}

/** Las llaves de los huecos que ya no hay que volver a pedir. */
export async function llavesResueltas(companyId: string, prefijo: string): Promise<Set<string>> {
  const filas = await prisma.solicitud.findMany({
    where: { companyId, dedupeKey: { startsWith: prefijo } },
    select: { dedupeKey: true },
  });
  return new Set(filas.map((f) => f.dedupeKey));
}

/** Marca que ya llegó lo que se pedía. `ref` dice QUÉ llegó. */
export async function recibirSolicitud(
  companyId: string,
  id: string,
  ref: string | null,
): Promise<SolicitudRegistrada | null> {
  const r = await prisma.solicitud.updateMany({
    where: { id, companyId, estado: "abierta" },
    data: { estado: "recibida", recibidaAt: new Date(), recibidaRef: ref },
  });
  if (r.count === 0) return null;
  const fila = await prisma.solicitud.findUnique({ where: { id }, select: SELECT });
  return fila ? aSolicitud(fila) : null;
}

/**
 * Cancela un pedido que no aplica.
 *
 * La razón se guarda en `recibidaRef` a propósito: es el campo de «qué pasó con
 * esto», y una cancelación sin motivo es indistinguible de un pedido perdido.
 */
export async function cancelarSolicitud(
  companyId: string,
  id: string,
  porque: string | null,
): Promise<SolicitudRegistrada | null> {
  const r = await prisma.solicitud.updateMany({
    where: { id, companyId, estado: "abierta" },
    data: { estado: "cancelada", recibidaAt: new Date(), recibidaRef: porque },
  });
  if (r.count === 0) return null;
  const fila = await prisma.solicitud.findUnique({ where: { id }, select: SELECT });
  return fila ? aSolicitud(fila) : null;
}

/** Deja constancia de que ya se avisó por un canal, sin duplicarlo. */
export async function marcarAvisada(companyId: string, id: string, canal: string): Promise<void> {
  const fila = await prisma.solicitud.findFirst({ where: { id, companyId }, select: { canalNotif: true } });
  if (!fila || fila.canalNotif.includes(canal)) return;
  await prisma.solicitud.updateMany({
    where: { id, companyId },
    data: { canalNotif: [...fila.canalNotif, canal] },
  });
}
