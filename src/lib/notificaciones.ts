import { prisma } from "./prisma";
import { sendPushToUser, type NotifCategoria } from "./push";
import type { EstadoPendiente } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Inbox unificado de "Pendientes". Cada notificación proactiva que hoy sólo se
// empuja por web-push (efímero, por dispositivo) se PERSISTE además como un
// NotificationItem que el usuario puede seguir (leer / hecho / posponer),
// cross-empresa y con deep-link. El push y el inbox son el MISMO registro: la
// idempotencia es por (recipientUserId, dedupeKey), reusando el `tag` de colapso
// del push como llave.
//
// No introduce LLM ni acciones irreversibles: sólo registra + empuja.
// ─────────────────────────────────────────────────────────────────────────────

/** Categorías del inbox (qué generó el pendiente). */
export type CategoriaPendiente =
  | "briefing"
  | "estado_cuenta"
  | "nomina"
  | "proyeccion"
  | "ce"
  | "otro";

export type SeveridadPendiente = "info" | "warn" | "error";

/**
 * Decisión PURA del estado al re-disparar una alerta ya existente. Testeable sin
 * DB. `actual` es el estado guardado; `posponerHasta` su snooze (o null); `now`
 * el momento de referencia.
 *
 *   - VISTO            → NUEVO   (una alerta re-disparada vuelve a ser nueva)
 *   - POSPUESTO vencido → NUEVO  (el snooze expiró: reaparece)
 *   - POSPUESTO vigente → POSPUESTO (no molestar todavía)
 *   - HECHO            → HECHO   (atendido: no re-molestar)
 *   - NUEVO            → NUEVO   (sigue pendiente)
 */
export function siguienteEstado(
  actual: EstadoPendiente,
  posponerHasta: Date | null,
  now: Date,
): EstadoPendiente {
  switch (actual) {
    case "NUEVO":
      return "NUEVO";
    case "VISTO":
      // Re-disparo de algo ya visto: es nuevo otra vez.
      return "NUEVO";
    case "POSPUESTO":
      // Si el snooze ya venció, reaparece; si sigue vigente, no molestar.
      if (posponerHasta && posponerHasta.getTime() > now.getTime()) return "POSPUESTO";
      return "NUEVO";
    case "HECHO":
      // Atendido: no re-molestar (aunque la alerta se vuelva a calcular).
      return "HECHO";
    default:
      return "NUEVO";
  }
}

export interface RegistrarYNotificarInput {
  recipientUserId: string;
  companyId?: string | null;
  categoria: CategoriaPendiente;
  severidad: SeveridadPendiente;
  titulo: string;
  cuerpo: string;
  url: string;
  /** Reusa el `tag` de colapso del push: idempotencia por (usuario, dedupeKey). */
  dedupeKey: string;
  /** Categoría de preferencia del push (opt-out por usuario). */
  categoriaPush?: NotifCategoria;
}

export interface RegistrarYNotificarResult {
  itemId: string;
  pushSent: boolean;
}

/**
 * Registra (upsert) el pendiente en el inbox y empuja el push correspondiente.
 *
 *   - Crea (estado NUEVO) si no existe el (recipientUserId, dedupeKey).
 *   - Si existe, refresca titulo/cuerpo/url/severidad y recalcula el estado con
 *     `siguienteEstado` (un re-disparo de algo VISTO o de un POSPUESTO vencido
 *     vuelve a NUEVO; HECHO o POSPUESTO vigente se respetan: no molestar).
 *
 * Devuelve el id del item y si el push salió a al menos un dispositivo.
 */
export async function registrarYNotificar(
  input: RegistrarYNotificarInput,
  now: Date = new Date(),
): Promise<RegistrarYNotificarResult> {
  const {
    recipientUserId,
    companyId = null,
    categoria,
    severidad,
    titulo,
    cuerpo,
    url,
    dedupeKey,
    categoriaPush,
  } = input;

  const existente = await prisma.notificationItem.findUnique({
    where: { recipientUserId_dedupeKey: { recipientUserId, dedupeKey } },
    select: { id: true, estado: true, posponerHasta: true },
  });

  let itemId: string;
  if (!existente) {
    const creado = await prisma.notificationItem.create({
      data: {
        recipientUserId,
        companyId,
        categoria,
        severidad,
        titulo,
        cuerpo,
        url,
        dedupeKey,
        estado: "NUEVO",
      },
      select: { id: true },
    });
    itemId = creado.id;
  } else {
    const nuevoEstado = siguienteEstado(existente.estado, existente.posponerHasta, now);
    // Si vuelve a NUEVO, limpiamos el snooze vencido para que no quede colgando.
    const limpiarSnooze =
      existente.estado === "POSPUESTO" && nuevoEstado === "NUEVO";
    const actualizado = await prisma.notificationItem.update({
      where: { id: existente.id },
      data: {
        companyId,
        categoria,
        severidad,
        titulo,
        cuerpo,
        url,
        estado: nuevoEstado,
        ...(limpiarSnooze ? { posponerHasta: null } : {}),
      },
      select: { id: true },
    });
    itemId = actualizado.id;
  }

  const push = await sendPushToUser(
    recipientUserId,
    { title: titulo, body: cuerpo, url, tag: dedupeKey },
    categoriaPush,
  );

  return { itemId, pushSent: push.sent > 0 };
}
