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
  /** Operador de plataforma (User.esOperador): sus empresas son de la casa. */
  esOperador?: boolean;
};

/**
 * Nivel de pago de una empresa según sus pagadores:
 *   ACTIVO  — alguien paga de verdad (ACTIVE, o PAST_DUE en gracia).
 *   TRIAL   — nadie paga aún, pero hay un trial EN CURSO. Prueba ≠ cliente:
 *             el COGS de trial se acota (extracciones básicas, sin backfill).
 *   NINGUNO — nadie vigente (vencidos/cancelados) → sin COGS, slot liberable.
 */
export type NivelPago = "ACTIVO" | "TRIAL" | "NINGUNO";

/**
 * Nivel de pago a partir de los pagadores (puro — testeable sin DB). Misma
 * regla que computeState (subscription.ts): TRIALING sólo cuenta con trial en
 * curso — vencido equivale a EXPIRED. No se importa subscription.ts porque su
 * cadena (authz → next-auth) no carga fuera de Next.
 */
export function nivelPago(pagadores: PagadorSub[]): NivelPago {
  const ahora = Date.now();
  let hayTrial = false;
  for (const p of pagadores) {
    // Empresas del operador de plataforma (las "de la casa"): ACTIVO siempre —
    // el operador se paga a sí mismo. Mismo override que suspension.ts y el
    // gate de escritura, para que el COGS nunca se corte en las propias.
    if (p.esOperador) return "ACTIVO";
    if (p.subscriptionStatus === "ACTIVE" || p.subscriptionStatus === "PAST_DUE") return "ACTIVO";
    if (
      p.subscriptionStatus === "TRIALING" &&
      !!p.trialEndsAt &&
      p.trialEndsAt.getTime() > ahora
    ) {
      hayTrial = true;
    }
  }
  return hayTrial ? "TRIAL" : "NINGUNO";
}

/** ¿Algún pagador sigue vigente? (trial en curso incluido). */
export function hayPagoVigente(pagadores: PagadorSub[]): boolean {
  return nivelPago(pagadores) !== "NINGUNO";
}

const PAYER_SELECT = {
  user: { select: { subscriptionStatus: true, trialEndsAt: true, esOperador: true } },
} as const;

/**
 * Nivel de pago de cada empresa del lote, en una sola consulta (para crons).
 * Empresas no encontradas no aparecen en el mapa (trátalas como NINGUNO).
 */
export async function nivelPagoEmpresas(companyIds: string[]): Promise<Map<string, NivelPago>> {
  if (companyIds.length === 0) return new Map();
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
  const niveles = new Map<string, NivelPago>();
  for (const c of companies) {
    const pagadores = [
      ...c.members.map((m) => m.user),
      ...(c.despacho?.members.map((m) => m.user) ?? []),
    ];
    niveles.set(c.id, nivelPago(pagadores));
  }
  return niveles;
}

/**
 * Subconjunto de `companyIds` cuyas empresas tienen al menos un pagador
 * vigente (ACTIVO o TRIAL en curso).
 */
export async function empresasConPagoVigente(companyIds: string[]): Promise<Set<string>> {
  const niveles = await nivelPagoEmpresas(companyIds);
  return new Set(
    Array.from(niveles.entries())
      .filter(([, n]) => n !== "NINGUNO")
      .map(([id]) => id)
  );
}
