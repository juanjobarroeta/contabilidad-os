// ─────────────────────────────────────────────────────────────────────────────
// ¿Quién PAGA por una empresa y sigue pagando? Los pagadores de una empresa son
// sus miembros OWNER/ADMIN y, si pertenece a un despacho, los OWNER/ADMIN del
// despacho (el despacho es el cliente que paga su cartera). Una empresa "con
// pago vigente" tiene al menos un pagador con suscripción TRIALING/ACTIVE/
// PAST_DUE (la gracia de PAST_DUE es la MISMA política del gate de escritura,
// subscription-gate.ts — coherencia deliberada).
//
// Se usa para cortar el COGS de clientes que dejaron de pagar: las extracciones
// de Syntage (y la liberación de su slot/RFC vinculado) se deciden con esto.
// ─────────────────────────────────────────────────────────────────────────────

import type { SubscriptionStatus } from "@prisma/client";
import { prisma } from "../prisma";

export type PagadorSub = {
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: Date | null;
};

/**
 * ¿Algún pagador sigue vigente? (puro — testeable sin DB). Misma regla que
 * computeState (subscription.ts): TRIALING sólo cuenta con trial en curso —
 * vencido equivale a EXPIRED. No se importa subscription.ts porque su cadena
 * (authz → next-auth) no carga fuera de Next.
 */
export function hayPagoVigente(pagadores: PagadorSub[]): boolean {
  const ahora = Date.now();
  return pagadores.some((p) => {
    if (p.subscriptionStatus === "ACTIVE" || p.subscriptionStatus === "PAST_DUE") return true;
    return (
      p.subscriptionStatus === "TRIALING" &&
      !!p.trialEndsAt &&
      p.trialEndsAt.getTime() > ahora
    );
  });
}

const PAYER_SELECT = {
  user: { select: { subscriptionStatus: true, trialEndsAt: true } },
} as const;

/**
 * Subconjunto de `companyIds` cuyas empresas tienen al menos un pagador
 * vigente. Una sola consulta para todo el lote (pensado para crons).
 */
export async function empresasConPagoVigente(companyIds: string[]): Promise<Set<string>> {
  if (companyIds.length === 0) return new Set();
  const companies = await prisma.company.findMany({
    where: { id: { in: companyIds } },
    select: {
      id: true,
      members: { where: { role: { in: ["OWNER", "ADMIN"] } }, select: PAYER_SELECT },
      despacho: {
        select: {
          members: { where: { role: { in: ["OWNER", "ADMIN"] } }, select: PAYER_SELECT },
        },
      },
    },
  });
  const vigentes = new Set<string>();
  for (const c of companies) {
    const pagadores = [
      ...c.members.map((m) => m.user),
      ...(c.despacho?.members.map((m) => m.user) ?? []),
    ];
    if (hayPagoVigente(pagadores)) vigentes.add(c.id);
  }
  return vigentes;
}
