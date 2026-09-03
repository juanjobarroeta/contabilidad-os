import type { CompanyPlan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { dailyChatMsgsPerUser } from "@/lib/planes";

// ─────────────────────────────────────────────────────────────────────────────
// Tope diario POR USUARIO del asistente DENTRO de la app.
//
// El techo mensual de IA (src/lib/ai/guardia.ts) protege el COGS a nivel
// EMPRESA, pero no impide que un solo usuario en una empresa con presupuesto
// amplio (p.ej. DESPACHO) monopolice ese presupuesto compartido: cada POST del
// chat puede correr hasta MAX_TOOL_ROUNDS rondas del modelo, así que un usuario
// abusivo vacía el presupuesto y dispara el gasto sin backstop individual.
//
// Este módulo cierra ese hueco con un COUNT barato de los mensajes que el propio
// usuario escribió hoy (índice authorId/createdAt implícito por el filtro). Es
// el mismo patrón que el `dailyMsgsPerUser` del asistente de WhatsApp: la
// DECISIÓN es una función pura (conteo + límite → permitido) para que sea
// testeable sin DB; la consulta sólo la alimenta.
// ─────────────────────────────────────────────────────────────────────────────

const TZ = "America/Mexico_City";

export const MENSAJE_TOPE_DIARIO_CHAT =
  "Alcanzaste tu límite de mensajes por hoy en el asistente. Inténtalo de nuevo mañana.";

export interface ChatUserDailyDecision {
  allowed: boolean;
  mensaje?: string;
}

/**
 * Decisión PURA: dado el conteo de mensajes que el usuario ya escribió hoy y el
 * tope diario de su tier, ¿se permite este mensaje nuevo? Un tope de 0 bloquea
 * siempre (defensa en profundidad; ningún tier lo tiene hoy).
 */
export function decideChatUserDaily(input: {
  dailyCount: number;
  limit: number;
}): ChatUserDailyDecision {
  if (input.limit <= 0 || input.dailyCount >= input.limit) {
    return { allowed: false, mensaje: MENSAJE_TOPE_DIARIO_CHAT };
  }
  return { allowed: true };
}

/** Inicio del día actual (00:00) en la zona horaria de México, como instante UTC. */
function startOfDayMx(now = new Date()): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // "YYYY-MM-DD" en hora de México
  // CDMX está en UTC-06:00 (sin horario de verano desde 2023): 00:00 MX = 06:00 UTC.
  return new Date(`${ymd}T06:00:00.000Z`);
}

/**
 * Comprueba el tope diario por usuario ANTES de invocar el modelo. Una sola
 * consulta barata: COUNT de los mensajes con rol "user" que este usuario escribió
 * desde el inicio del día en hora de México. El conteo es GLOBAL por usuario (no
 * por empresa): ChatMessage no lleva companyId, y el objetivo es acotar a la
 * persona, no a la conversación. `companyId` sólo se usa para resolver el tope
 * del tier vía `plan`.
 */
export async function checkChatUserDaily(opts: {
  userId: string;
  companyId: string;
  plan: CompanyPlan;
}): Promise<ChatUserDailyDecision> {
  const limit = dailyChatMsgsPerUser(opts.plan);
  if (limit <= 0) {
    return decideChatUserDaily({ dailyCount: 0, limit });
  }

  const dailyCount = await prisma.chatMessage.count({
    where: {
      authorId: opts.userId,
      role: "user",
      createdAt: { gte: startOfDayMx() },
    },
  });

  return decideChatUserDaily({ dailyCount, limit });
}
