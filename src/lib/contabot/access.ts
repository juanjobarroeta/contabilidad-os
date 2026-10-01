import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { estadoIAEmpresa, asegurarUsoIA } from "@/lib/ai/guardia";
import { gateEscritura } from "@/lib/subscription";
import { ContaBotError, managedContaBotEnabled } from "./config";

/** Runs on each tool callback, not just when a conversation starts. */
export async function requireContaBotAccess(userId: string, companyId: string, conversationId?: string,
  options: { requireEnabled?: boolean } = {}) {
  if (options.requireEnabled !== false && !managedContaBotEnabled(companyId)) throw new ContaBotError(403, "ContaBot no está habilitado para esta empresa.");
  const member = await getEffectiveCompanyMembership(userId, companyId, { platformOperatorMode: "deny" });
  if (!member) throw new ContaBotError(403, "Sin acceso a esta empresa.");
  // A satellite-only account cannot gain general accounting access through AI.
  // Conservative for the pilot, including users with a second despacho grant.
  const direct = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId, companyId } },
    select: { allowedModules: true, construccionRol: true, purifPuesto: true },
  });
  if (direct && (direct.construccionRol || direct.purifPuesto ||
    (direct.allowedModules.length > 0 && !direct.allowedModules.includes("CONTABILIDAD")))) {
    throw new ContaBotError(403, "Tu cuenta no tiene acceso al agente contable.");
  }
  if (conversationId) {
    const conv = await prisma.chatConversation.findUnique({ where: { id: conversationId } });
    if (!conv || conv.companyId !== companyId || conv.archivedAt ||
      (conv.userId !== userId && conv.visibility !== "COMPANY")) {
      throw new ContaBotError(403, "Sin acceso a esta conversación.");
    }
  }
  return { canWrite: member.role !== "VIEWER" };
}

export async function requireContaBotBudget(userId: string, companyId: string) {
  if (await gateEscritura(userId)) throw new ContaBotError(402, "Revisa la suscripción para continuar usando ContaBot.");
  // The legacy guard is fail-open on database failure. A durable agent must
  // establish a known company balance before starting or returning tool data.
  const budget = await estadoIAEmpresa(companyId);
  if (!budget) throw new ContaBotError(503, "No se pudo verificar el presupuesto de IA.");
  if (budget.gastoMesUsd >= budget.topeMesUsd) throw new ContaBotError(429, "Esta empresa alcanzó su límite mensual de IA.");
  const decision = await asegurarUsoIA({ userId, companyId });
  if (!decision.ok) throw new ContaBotError(429, decision.mensaje);
}
