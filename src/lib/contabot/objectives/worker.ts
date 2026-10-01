import { prisma } from "@/lib/prisma";
import { beginManagedTurn, syncManagedSession } from "../runtime";
import { ContaBotError, managedContaBotEnabled } from "../config";
import { materializeMandate, refreshObjective } from "./service";
import { esClavePaso } from "@/lib/cierre/claves";

export async function startObjectiveRun(id: string) {
  const run = await prisma.contaBotObjectiveRun.findUniqueOrThrow({ where: { id }, include: { objective: true } });
  if (run.state !== "queued") return;
  try {
    if (!run.objective.conversationId) throw new ContaBotError(409, "La conversación del objetivo ya no existe.");
    const session = await beginManagedTurn({ companyId: run.companyId, userId: run.userId,
      conversationId: run.objective.conversationId, requestId: run.id, objectiveRunId: run.id,
      text: run.input, instructions: "Revisión delegada y acotada. Conserva los permisos y confirmaciones de ContaBot.",
      context: { cierre: { year: run.objective.year, month: run.objective.month,
        ...(esClavePaso(run.objective.scope) ? { paso: run.objective.scope } : {}) } },
    });
    await syncManagedSession(session.id);
  } catch (error) {
    // A busy company can retry this SAME durable request. Once bound to a
    // session, provider recovery owns it, including uncertain submissions.
    const current = await prisma.contaBotObjectiveRun.findUniqueOrThrow({ where: { id } });
    if (current.sessionId || current.state !== "queued") return;
    if (error instanceof ContaBotError && error.status === 409 && run.objective.conversationId && !run.objective.pausedAt) return;
    const message = error instanceof ContaBotError ? error.message : "No se pudo iniciar la revisión. Revisa configuración y presupuesto antes de reanudar.";
    await prisma.$transaction(async (tx) => {
      const failed = await tx.contaBotObjectiveRun.updateMany({ where: { id, state: "queued" }, data: {
        state: "failed", activeCompanyId: null, error: message, completedAt: new Date(),
      } });
      if (failed.count) await tx.contaBotObjective.updateMany({ where: { id: run.objectiveId, pausedAt: null }, data: {
        state: "blocked", lastError: message, nextAction: message, version: { increment: 1 },
      } });
    });
  }
}

/** Bounded durable scheduler; webhooks/recovery continue the managed turns. */
export async function runObjectivePass(now = new Date()) {
  const allowed = (process.env.CONTABOT_MANAGED_COMPANY_IDS ?? "").split(",").map((id) => id.trim()).filter(managedContaBotEnabled);
  if (!allowed.length) return { assigned: 0, checked: 0, dispatched: 0 };
  const deadline = Date.now() + 160_000;
  const mandates = await prisma.contaBotMandate.findMany({ where: { companyId: { in: allowed }, enabled: true, nextCheckAt: { lte: now } },
    orderBy: { nextCheckAt: "asc" }, take: 3, select: { companyId: true } });
  for (const mandate of mandates) {
    if (Date.now() >= deadline) break;
    await materializeMandate(mandate.companyId, now);
  }
  const objectives = await prisma.contaBotObjective.findMany({ where: { companyId: { in: allowed }, pausedAt: null, nextCheckAt: { lte: now } },
    orderBy: [{ nextCheckAt: "asc" }, { year: "asc" }, { month: "asc" }], take: 3, select: { id: true } });
  let checked = 0, dispatched = 0;
  for (const objective of objectives) {
    if (Date.now() >= deadline) break;
    await refreshObjective(objective.id, now);
    checked++;
  }
  const queued = await prisma.contaBotObjectiveRun.findMany({ where: { companyId: { in: allowed }, state: "queued" },
    orderBy: { createdAt: "asc" }, take: 3, select: { id: true } });
  for (const run of queued) {
    if (Date.now() >= deadline) break;
    await startObjectiveRun(run.id);
    dispatched++;
  }
  return { assigned: mandates.length, checked, dispatched };
}
