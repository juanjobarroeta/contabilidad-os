import { prisma } from "@/lib/prisma";
import { chatLlmUsdMensual, effectiveWhatsappPlan } from "@/lib/planes";

// ─────────────────────────────────────────────────────────────────────────────
// Tope de costo-seguridad del asistente DENTRO de la app.
//
// Igual que el agente de WhatsApp, el chat in-app se mide con CostEvent (LLM,
// subtipo "ai.chat") y se acota con un presupuesto mensual de LLM por empresa.
// La DECISIÓN es pura (gasto + tope → permitido) para ser testeable sin DB; la
// consulta sólo la alimenta. Una empresa de despacho hereda el tope de DESPACHO.
// ─────────────────────────────────────────────────────────────────────────────

const TZ = "America/Mexico_City";

export const MENSAJE_PRESUPUESTO_CHAT =
  "Esta empresa alcanzó su límite mensual de uso del asistente. Contacta a tu administrador o despacho.";

export interface ChatBudgetDecision {
  allowed: boolean;
  mensaje?: string;
}

/** Decisión PURA: ¿el gasto del mes está por debajo del tope? */
export function decideChatBudget(input: {
  monthlyLlmUsd: number;
  limitUsd: number;
}): ChatBudgetDecision {
  if (input.monthlyLlmUsd >= input.limitUsd) {
    return { allowed: false, mensaje: MENSAJE_PRESUPUESTO_CHAT };
  }
  return { allowed: true };
}

/** Inicio del mes natural actual (día 1, 00:00) en hora de México, como UTC. */
function startOfMonthMx(now = new Date()): Date {
  const ym = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(now);
  return new Date(`${ym}-01T06:00:00.000Z`);
}

/**
 * Comprueba el presupuesto mensual de LLM del chat in-app ANTES de invocar el
 * modelo. Una sola consulta barata (SUM sobre índice companyId+occurredAt).
 */
export async function checkChatBudget(opts: {
  companyId: string;
  tier: Parameters<typeof effectiveWhatsappPlan>[0]["tier"];
  despachoId: string | null;
}): Promise<ChatBudgetDecision> {
  const plan = effectiveWhatsappPlan({ tier: opts.tier, despachoId: opts.despachoId });
  const limitUsd = chatLlmUsdMensual(plan);

  const costAgg = await prisma.costEvent.aggregate({
    where: {
      companyId: opts.companyId,
      categoria: "LLM",
      subtipo: "ai.chat",
      occurredAt: { gte: startOfMonthMx() },
    },
    _sum: { costoMicroUsd: true },
  });
  const monthlyLlmUsd = (costAgg._sum.costoMicroUsd ?? 0) / 1_000_000;

  return decideChatBudget({ monthlyLlmUsd, limitUsd });
}
