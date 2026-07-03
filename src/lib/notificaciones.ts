import { prisma } from "./prisma";
import { sendPushToUser, type NotifCategoria } from "./push";
import { conParametroAsk } from "./notif-ask";
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

const TZ_MX = "America/Mexico_City";

/**
 * Fecha local de México `YYYY-MM-DD`, para dedupeKeys fechados (p.ej.
 * `briefing-matutino:2026-07-03`). Un dedupeKey fechado + `pushSoloAlCrear`
 * garantiza "a lo más un push al día" por usuario.
 */
export function fechaLocalMx(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ_MX }).format(now);
}

/**
 * Instante UTC de la medianoche de HOY en México, para acotar consultas "de hoy"
 * (p.ej. CFDIs importados hoy). CDMX es UTC-6 fijo desde 2022 (sin DST).
 */
export function inicioDelDiaMx(now: Date = new Date()): Date {
  return new Date(`${fechaLocalMx(now)}T00:00:00-06:00`);
}

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
 *
 * OJO: esta es la transición "cruda". La decisión completa (¿se aplica el flip
 * VISTO→NUEVO? ¿sale push?) vive en `decidirNotificacion`, que sólo flippea
 * VISTO→NUEVO cuando el contenido realmente cambió.
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

/** Snapshot mínimo del item guardado, para decidir un re-disparo. */
export interface ItemExistenteSnapshot {
  estado: EstadoPendiente;
  posponerHasta: Date | null;
  titulo: string;
  cuerpo: string;
}

/** Qué hacer ante un disparo (creación o re-disparo). Decisión PURA, testeable. */
export interface DecisionNotificacion {
  /** No existía el (usuario, dedupeKey): hay que crear el item. */
  crear: boolean;
  /** Estado resultante del item. */
  estado: EstadoPendiente;
  /** Hay que escribir la fila (contenido y/o estado cambian). `false` = silencio total. */
  actualizar: boolean;
  /** Limpiar un snooze vencido para que no quede colgando. */
  limpiarSnooze: boolean;
  /** Enviar el web-push. */
  push: boolean;
}

/**
 * Decisión PURA de qué hacer ante un disparo de alerta. Reglas de push — el push
 * sale SOLO en transiciones reales, nunca en re-disparos sin novedad (un cron
 * 3×/día no debe re-empujar la misma alerta tres veces):
 *
 *   1. Item nuevo (no existía)            → crear + PUSH (siempre, incluso con
 *      `pushSoloAlCrear`).
 *   2. Re-disparo con contenido IDÉNTICO (mismo titulo+cuerpo) y estado
 *      NUEVO/VISTO                        → silencio total: NO push y NO se
 *      flippea VISTO→NUEVO (leerlo debe "pegarse" si no hay nada nuevo).
 *   3. Re-disparo con contenido NUEVO y estado NUEVO/VISTO → hay novedad real:
 *      refrescar el inbox, volver a NUEVO y PUSH (salvo `pushSoloAlCrear`).
 *   4. HECHO                              → se respeta SIEMPRE: nunca revive ni
 *      empuja (semántica actual de `siguienteEstado` preservada). Si el
 *      contenido cambió, sólo se refresca para que el inbox no muestre datos
 *      viejos.
 *   5. POSPUESTO vigente                  → no molestar; sólo refrescar
 *      contenido si cambió.
 *   6. POSPUESTO vencido                  → transición real POSPUESTO→NUEVO
 *      ("recuérdamelo después" venció): reaparece y PUSH aunque el contenido
 *      sea idéntico — es la promesa del snooze (salvo `pushSoloAlCrear`).
 *
 * `pushSoloAlCrear` reserva el push EXCLUSIVAMENTE a la creación del item: los
 * re-disparos siguen actualizando el inbox (estado y contenido) pero en
 * silencio. Combinado con un dedupeKey fechado (`...:<YYYY-MM-DD>`) da "a lo
 * más un push al día": el primer disparo del día crea y empuja; los siguientes
 * del mismo día sólo acumulan en el inbox.
 */
export function decidirNotificacion(
  existente: ItemExistenteSnapshot | null,
  entrante: { titulo: string; cuerpo: string },
  now: Date,
  opts: { pushSoloAlCrear?: boolean } = {},
): DecisionNotificacion {
  // Regla 1: creación — siempre empuja.
  if (!existente) {
    return { crear: true, estado: "NUEVO", actualizar: true, limpiarSnooze: false, push: true };
  }

  const contenidoCambio =
    existente.titulo !== entrante.titulo || existente.cuerpo !== entrante.cuerpo;
  const pushSiPermitido = !opts.pushSoloAlCrear;

  // Regla 4: HECHO nunca revive ni empuja; el contenido sí se refresca.
  if (existente.estado === "HECHO") {
    return { crear: false, estado: "HECHO", actualizar: contenidoCambio, limpiarSnooze: false, push: false };
  }

  if (existente.estado === "POSPUESTO") {
    const vigente = siguienteEstado(existente.estado, existente.posponerHasta, now) === "POSPUESTO";
    // Regla 5: snooze vigente — no molestar.
    if (vigente) {
      return { crear: false, estado: "POSPUESTO", actualizar: contenidoCambio, limpiarSnooze: false, push: false };
    }
    // Regla 6: snooze vencido — reaparece y empuja aunque no haya novedad.
    return { crear: false, estado: "NUEVO", actualizar: true, limpiarSnooze: true, push: pushSiPermitido };
  }

  // Regla 2: NUEVO/VISTO sin novedad — silencio total (sin flip VISTO→NUEVO).
  if (!contenidoCambio) {
    return { crear: false, estado: existente.estado, actualizar: false, limpiarSnooze: false, push: false };
  }

  // Regla 3: NUEVO/VISTO con novedad real — vuelve a NUEVO y empuja.
  return { crear: false, estado: "NUEVO", actualizar: true, limpiarSnooze: false, push: pushSiPermitido };
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
  /**
   * Si al abrir la notificación (push o inbox) el asistente debe abrirse ya
   * sembrado con el contexto de este pendiente. Por defecto `true`: se adjunta
   * `?ask=<dedupeKey>` a la URL (del item y del push) para que el handler global
   * lo detecte al aterrizar. Pásalo `false` para un deep-link sin chat.
   */
  abrirChat?: boolean;
  /**
   * Reserva el push EXCLUSIVAMENTE a la creación del item: los re-disparos
   * actualizan el inbox en silencio. Combinado con un dedupeKey fechado
   * (`...:<YYYY-MM-DD>`) da "a lo más un push al día". Ver `decidirNotificacion`.
   */
  pushSoloAlCrear?: boolean;
}

export interface RegistrarYNotificarResult {
  itemId: string;
  pushSent: boolean;
}

/**
 * Registra (upsert) el pendiente en el inbox y empuja el push SOLO en
 * transiciones reales (ver reglas en `decidirNotificacion`):
 *
 *   - Crea (estado NUEVO) si no existe el (recipientUserId, dedupeKey) → push.
 *   - Re-disparo sin novedad (mismo titulo+cuerpo, estado NUEVO/VISTO) →
 *     silencio total: sin push, sin escritura y sin flip VISTO→NUEVO.
 *   - Re-disparo con contenido nuevo → refresca el inbox, vuelve a NUEVO y
 *     empuja (salvo `pushSoloAlCrear`).
 *   - HECHO se respeta siempre; POSPUESTO vigente no molesta; POSPUESTO vencido
 *     reaparece con push.
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
    abrirChat = true,
    pushSoloAlCrear = false,
  } = input;

  // El puntero `?ask=<dedupeKey>` viaja en la MISMA URL del item y del push, de
  // modo que cualquier tap (inbox o notificación) siembra el chat al aterrizar.
  const urlFinal = abrirChat ? conParametroAsk(url, dedupeKey) : url;

  const existente = await prisma.notificationItem.findUnique({
    where: { recipientUserId_dedupeKey: { recipientUserId, dedupeKey } },
    select: { id: true, estado: true, posponerHasta: true, titulo: true, cuerpo: true },
  });

  const decision = decidirNotificacion(existente, { titulo, cuerpo }, now, { pushSoloAlCrear });

  let itemId: string;
  if (decision.crear || !existente) {
    const creado = await prisma.notificationItem.create({
      data: {
        recipientUserId,
        companyId,
        categoria,
        severidad,
        titulo,
        cuerpo,
        url: urlFinal,
        dedupeKey,
        estado: "NUEVO",
      },
      select: { id: true },
    });
    itemId = creado.id;
  } else {
    itemId = existente.id;
    if (decision.actualizar) {
      await prisma.notificationItem.update({
        where: { id: itemId },
        data: {
          companyId,
          categoria,
          severidad,
          titulo,
          cuerpo,
          url: urlFinal,
          estado: decision.estado,
          ...(decision.limpiarSnooze ? { posponerHasta: null } : {}),
        },
      });
    }
  }

  if (!decision.push) return { itemId, pushSent: false };

  const push = await sendPushToUser(
    recipientUserId,
    { title: titulo, body: cuerpo, url: urlFinal, tag: dedupeKey },
    categoriaPush,
  );

  return { itemId, pushSent: push.sent > 0 };
}
