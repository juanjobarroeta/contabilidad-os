// ─────────────────────────────────────────────────────────────────────────────
// GATE del cierre guiado: membresía + plan. Primer gate de plan a nivel
// página/API del repo (hasta hoy el plan sólo gateaba COGS en libs); el 402
// sigue la convención de gateEscritura (suscripción). `withAuthz` convierte el
// AuthzError en JSON.
// ─────────────────────────────────────────────────────────────────────────────

import type { MemberRole } from "@prisma/client";
import { prisma } from "../prisma";
import { AuthzError, requireMembership } from "../authz";
import { effectiveCierrePlan, planIncluyeCierreGuiado } from "../planes";

/** ¿La empresa tiene el cierre guiado en su plan (propio o heredado del despacho)? */
export async function empresaTieneCierreGuiado(companyId: string): Promise<boolean> {
  const c = await prisma.company.findUnique({
    where: { id: companyId },
    select: { tier: true, despacho: { select: { defaultTier: true } } },
  });
  if (!c) return false;
  return planIncluyeCierreGuiado(effectiveCierrePlan(c));
}

/**
 * Exige membresía (con los roles dados) y plan con cierre guiado. Lanza
 * AuthzError 402 con `upgrade: PRO` cuando el plan no lo incluye.
 */
export async function requireCierreGuiado(companyId: string, allowedRoles?: MemberRole[], req?: Request) {
  const acceso = await requireMembership(companyId, allowedRoles, req);
  if (!(await empresaTieneCierreGuiado(companyId))) {
    throw new AuthzError(402, "El cierre guiado es una función del plan Pro. Actualiza el plan de la empresa para usarlo.");
  }
  return acceso;
}

/** `?companyId=&year=&month=` validado, o null. */
export function parsePeriodoQuery(sp: URLSearchParams): { companyId: string; year: number; month: number } | null {
  const companyId = sp.get("companyId");
  const year = parseInt(sp.get("year") ?? "");
  const month = parseInt(sp.get("month") ?? "");
  if (!companyId || isNaN(year) || isNaN(month) || month < 1 || month > 12 || year < 2000 || year > 2100) return null;
  return { companyId, year, month };
}
