// ─────────────────────────────────────────────────────────────────────────────
// La bitácora del caso: sólo se agrega, nunca se edita ni se borra.
//
// Para qué: un despacho tiene que poder decir quién cambió qué y cuándo —ante
// su cliente, ante el colega que retoma el caso y, si hace falta, como
// evidencia. Antes no quedaba rastro: las versiones de un documento no tenían
// autor y los cambios al asunto no dejaban huella.
//
// Regla: apuntar en la bitácora NUNCA tumba la operación que la generó. Si la
// escritura falla, se reporta y la acción sigue: preferimos un renglón perdido
// a un contrato que no se guardó.
// ─────────────────────────────────────────────────────────────────────────────
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { reportError } from "@/lib/observability";

export type ActorTipo = "abogado" | "cliente" | "copiloto" | "sistema";

export type AccionBitacora =
  | "caso.creado"
  | "caso.actualizado"
  | "caso.cerrado"
  | "caso.reabierto"
  | "parte.registrada"
  | "parte.editada"
  | "parte.eliminada"
  | "parte.ligada_a_cliente"
  | "cliente.creado"
  | "cliente.ligado"
  | "cliente.editado"
  | "documento.creado"
  | "documento.version"
  | "documento.estado"
  | "tarea.creada"
  | "tarea.movida"
  | "tarea.asignada"
  | "tarea.eliminada"
  | "acceso.compartido"
  | "comentario.cliente";

export interface Actor {
  userId?: string | null;
  tipo?: ActorTipo;
  /** Para quien no tiene cuenta (el cliente que revisa por enlace). */
  nombre?: string | null;
}

export interface EntradaBitacora {
  id: string;
  casoId: string;
  actorUserId: string | null;
  actorTipo: ActorTipo;
  actorNombre: string | null;
  accion: string;
  entidad: string | null;
  entidadId: string | null;
  resumen: string;
  datos: unknown;
  createdAt: Date;
}

/**
 * Apunta un hecho en la bitácora del caso. Best-effort a propósito: devuelve
 * el id o null, y nunca lanza.
 */
export async function apuntar(args: {
  casoId: string;
  actor: Actor;
  accion: AccionBitacora;
  resumen: string;
  entidad?: string | null;
  entidadId?: string | null;
  datos?: unknown;
}): Promise<string | null> {
  try {
    const fila = await prisma.juridicoBitacora.create({
      data: {
        casoId: args.casoId,
        actorUserId: args.actor.userId ?? null,
        actorTipo: args.actor.tipo ?? "abogado",
        actorNombre: args.actor.nombre ?? null,
        accion: args.accion,
        entidad: args.entidad ?? null,
        entidadId: args.entidadId ?? null,
        resumen: args.resumen.slice(0, 2000),
        datos: args.datos === undefined ? Prisma.JsonNull : (JSON.parse(JSON.stringify(args.datos)) as Prisma.InputJsonValue),
      },
      select: { id: true },
    });
    return fila.id;
  } catch (e) {
    reportError(e, { ruta: "juridico/bitacora", casoId: args.casoId, accion: args.accion });
    return null;
  }
}

/** Varias entradas de un mismo hecho (p. ej. tres partes registradas a la vez). */
export async function apuntarVarias(entradas: Parameters<typeof apuntar>[0][]): Promise<void> {
  if (entradas.length === 0) return;
  try {
    await prisma.juridicoBitacora.createMany({
      data: entradas.map((e) => ({
        casoId: e.casoId,
        actorUserId: e.actor.userId ?? null,
        actorTipo: e.actor.tipo ?? "abogado",
        actorNombre: e.actor.nombre ?? null,
        accion: e.accion,
        entidad: e.entidad ?? null,
        entidadId: e.entidadId ?? null,
        resumen: e.resumen.slice(0, 2000),
        datos: e.datos === undefined ? Prisma.JsonNull : (JSON.parse(JSON.stringify(e.datos)) as Prisma.InputJsonValue),
      })),
    });
  } catch (e) {
    reportError(e, { ruta: "juridico/bitacora", paso: "varias", casoId: entradas[0]?.casoId });
  }
}

/** La bitácora del caso, de lo más nuevo a lo más viejo. */
export async function leerBitacora(casoId: string, opts: { limite?: number; antesDe?: Date; entidad?: string; entidadId?: string } = {}): Promise<EntradaBitacora[]> {
  const filas = await prisma.juridicoBitacora.findMany({
    where: {
      casoId,
      ...(opts.antesDe ? { createdAt: { lt: opts.antesDe } } : {}),
      ...(opts.entidad ? { entidad: opts.entidad } : {}),
      ...(opts.entidadId ? { entidadId: opts.entidadId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limite ?? 100, 500),
  });
  return filas.map((f) => ({ ...f, actorTipo: f.actorTipo as ActorTipo, datos: f.datos ?? null }));
}

/** Una línea legible para la UI: «Ana Torres registró 2 partes». Pura. */
export function frase(e: Pick<EntradaBitacora, "accion" | "resumen" | "actorTipo" | "actorNombre">, nombrePorUser?: string | null): string {
  const quien = e.actorNombre ?? nombrePorUser ?? (e.actorTipo === "copiloto" ? "El copiloto" : e.actorTipo === "sistema" ? "El sistema" : "Alguien");
  return `${quien}: ${e.resumen}`;
}
