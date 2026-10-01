import type { ContaBotSession, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { empresaTieneCierreGuiado } from "@/lib/cierre/gate";
import { companyRegimenCodesForPeriod, tipoPersonaFromRfc } from "@/lib/fiscal/regimen-capabilities";
import { rangoPeriodoMensual } from "@/lib/fiscal/periodo-operativo";
import { requireContaBotAccess } from "../access";
import { ContaBotError } from "../config";

/** Read only company scope before touching any accounting evidence. */
export async function requireObjectiveScope(companyId: string, year: number, month: number) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new ContaBotError(400, "Periodo inválido.");
  }
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: {
    rfc: true, regimenFiscal: true, isActive: true,
    regimenes: { select: { code: true, since: true, endedAt: true, active: true } },
  } });
  if (!company?.isActive) throw new ContaBotError(403, "Empresa inactiva.");
  const codes = companyRegimenCodesForPeriod({ ...company, ...rangoPeriodoMensual({ year, month }) });
  if (tipoPersonaFromRfc(company.rfc) !== "PM" || codes.length !== 1 || codes[0] !== "601") {
    throw new ContaBotError(422, "NOT_SUPPORTED: los objetivos automáticos requieren persona moral con régimen 601 único en el periodo.");
  }
  if (!(await empresaTieneCierreGuiado(companyId))) throw new ContaBotError(402, "Los objetivos de cierre requieren el plan Pro.");
}

export async function requireObjectiveAuthority(session: Pick<ContaBotSession, "objectiveRunId" | "companyId" | "userId" | "conversationId">) {
  if (!session.objectiveRunId) return;
  const run = await prisma.contaBotObjectiveRun.findUnique({ where: { id: session.objectiveRunId }, include: { objective: true } });
  if (!run || run.companyId !== session.companyId || run.userId !== session.userId ||
    run.objective.conversationId !== session.conversationId || run.objective.responsibleUserId !== session.userId ||
    run.objective.pausedAt || !["queued", "running"].includes(run.state)) {
    throw new ContaBotError(403, "La delegación de este objetivo se detuvo o cambió.");
  }
  if (run.objective.origin === "recurring") {
    const mandate = await prisma.contaBotMandate.findUnique({ where: { companyId: session.companyId } });
    if (!mandate?.enabled || mandate.responsibleUserId !== session.userId) {
      throw new ContaBotError(403, "La responsabilidad mensual está desactivada o cambió de responsable.");
    }
  }
  const access = await requireContaBotAccess(session.userId, session.companyId, session.conversationId);
  if (!access.canWrite) throw new ContaBotError(403, "El responsable ya no puede operar la contabilidad.");
  await requireObjectiveScope(session.companyId, run.objective.year, run.objective.month);
}

/** Settlement is in the same transaction as the managed response. Later chat
 * turns may reuse the session without overwriting this immutable attempt. */
export async function settleObjectiveRun(tx: Prisma.TransactionClient, session: ContaBotSession, error: string | null, costKnown: boolean) {
  if (!session.objectiveRunId || !costKnown) return;
  const updated = await tx.contaBotObjectiveRun.updateMany({ where: { id: session.objectiveRunId, state: { in: ["queued", "running"] } }, data: {
    state: error ? "failed" : "succeeded", error, activeCompanyId: null, completedAt: new Date(),
  } });
  if (!updated.count) return;
  const run = await tx.contaBotObjectiveRun.findUniqueOrThrow({ where: { id: session.objectiveRunId } });
  await tx.contaBotObjective.updateMany({ where: { id: run.objectiveId, pausedAt: null }, data: {
    state: error ? "blocked" : "verifying", lastError: error, nextCheckAt: new Date(), version: { increment: 1 },
  } });
}
