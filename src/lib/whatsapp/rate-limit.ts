import type { CompanyPlan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { whatsappLimites } from "@/lib/planes";

// ─────────────────────────────────────────────────────────────────────────────
// COSTO-SEGURIDAD del asistente de WhatsApp.
//
// El asistente sólo atiende a links VERIFICADOS y acota cada turno (MAX_TOKENS,
// MAX_TOOL_ROUNDS). El hueco que cierra este módulo es el VOLUMEN: un usuario
// verificado abusivo —o una cartera de despacho de decenas de clientes— podría
// disparar el costo de LLM sin tope. Imponemos dos topes baratos (un COUNT y un
// SUM, ambos sobre columnas indexadas), centralizados por tier en planes.ts:
//   1) Diario por usuario (link): mensajes entrantes desde el inicio del día MX.
//   2) Mensual por empresa: presupuesto de LLM (USD) del subtipo whatsapp.agent.
//
// La DECISIÓN es una función pura (conteos + límites → permitido/razón) para que
// sea testeable sin DB; las consultas sólo la alimentan.
// ─────────────────────────────────────────────────────────────────────────────

const TZ = "America/Mexico_City";

const MENSAJE_DIARIO =
  "Alcanzaste tu límite de consultas por hoy. Inténtalo mañana.";
const MENSAJE_MENSUAL =
  "Esta empresa alcanzó su límite de uso del asistente este mes. Contacta a tu despacho/administrador.";

export type RateLimitReason = "daily_user" | "monthly_company";

export interface RateLimitDecision {
  allowed: boolean;
  reason?: RateLimitReason;
  mensaje?: string;
}

/**
 * Decisión PURA: dados los conteos actuales y los límites del tier, ¿se permite
 * este turno? Se evalúa primero el tope diario por usuario y luego el mensual
 * por empresa (reportamos la primera razón que se incumple). Un límite de 0
 * significa "sin WhatsApp" y bloquea siempre — aunque el gate de plan ya debería
 * haber filtrado antes.
 */
export function decideWhatsappRateLimit(input: {
  dailyCount: number;
  monthlyLlmUsd: number;
  limits: { dailyMsgsPerUser: number; monthlyLlmUsd: number };
}): RateLimitDecision {
  const { dailyCount, monthlyLlmUsd, limits } = input;

  if (limits.dailyMsgsPerUser <= 0 || limits.monthlyLlmUsd <= 0) {
    return { allowed: false, reason: "daily_user", mensaje: MENSAJE_DIARIO };
  }

  if (dailyCount >= limits.dailyMsgsPerUser) {
    return { allowed: false, reason: "daily_user", mensaje: MENSAJE_DIARIO };
  }

  if (monthlyLlmUsd >= limits.monthlyLlmUsd) {
    return { allowed: false, reason: "monthly_company", mensaje: MENSAJE_MENSUAL };
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

/** Inicio del mes natural actual (día 1, 00:00) en hora de México, como instante UTC. */
function startOfMonthMx(now = new Date()): Date {
  const ym = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
  }).format(now); // "YYYY-MM"
  return new Date(`${ym}-01T06:00:00.000Z`);
}

/**
 * Comprueba los topes de costo-seguridad ANTES de invocar el LLM. Hace dos
 * consultas baratas:
 *   - COUNT de mensajes USER del link desde el inicio del día (índice
 *     conversationId+createdAt, acotado a las conversaciones del link).
 *   - SUM de costoMicroUsd de CostEvent (LLM / whatsapp.agent) de la empresa
 *     desde el inicio del mes (índice companyId+occurredAt).
 */
export async function checkWhatsappRateLimit(opts: {
  linkId: string;
  companyId: string;
  plan: CompanyPlan;
}): Promise<RateLimitDecision> {
  const { linkId, companyId, plan } = opts;
  const limits = whatsappLimites(plan);

  // Si el tier no incluye WhatsApp, ni siquiera tocamos la DB.
  if (limits.dailyMsgsPerUser <= 0 || limits.monthlyLlmUsd <= 0) {
    return decideWhatsappRateLimit({ dailyCount: 0, monthlyLlmUsd: 0, limits });
  }

  const dayStart = startOfDayMx();
  const monthStart = startOfMonthMx();

  const [dailyCount, costAgg] = await Promise.all([
    prisma.whatsappMessage.count({
      where: {
        role: "USER",
        createdAt: { gte: dayStart },
        conversation: { linkId },
      },
    }),
    prisma.costEvent.aggregate({
      where: {
        companyId,
        categoria: "LLM",
        subtipo: "whatsapp.agent",
        occurredAt: { gte: monthStart },
      },
      _sum: { costoMicroUsd: true },
    }),
  ]);

  const monthlyLlmUsd = (costAgg._sum.costoMicroUsd ?? 0) / 1_000_000;

  return decideWhatsappRateLimit({ dailyCount, monthlyLlmUsd, limits });
}
