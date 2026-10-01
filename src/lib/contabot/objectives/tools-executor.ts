import { assignObjective, listObjectives } from "./service";
import { ContaBotError } from "../config";

export async function executeObjectiveTool(name: string, args: Record<string, unknown>, userId: string, companyId: string) {
  try {
    if (name === "consultar_objetivos") {
      const result = await listObjectives(userId, companyId);
      return JSON.stringify({ dailyRunLimit: result.mandate?.maxRunsPerDay ?? 3, recurringEnabled: result.mandate?.enabled ?? false,
        objectives: result.objectives.map((o) => ({ id: o.id, title: o.title, year: o.year, month: o.month, scope: o.scope,
          responsibleUserId: o.responsibleUserId, state: o.state, nextAction: o.nextAction, dueDate: o.dueDate, lastCheckedAt: o.lastCheckedAt,
          lastError: o.lastError, conversationId: o.conversationId })) });
    }
    const objective = await assignObjective(userId, { companyId, year: args.year as number, month: args.month as number,
      scope: args.scope as string, instructions: args.instructions as string | undefined });
    return JSON.stringify({ objectiveId: objective.id, state: objective.state, conversationId: objective.conversationId,
      result: "Objetivo registrado. La revisión comienza en segundo plano; no significa cierre completado." });
  } catch (error) {
    if (error instanceof ContaBotError) return JSON.stringify({ error: error.message, status: error.status });
    throw error;
  }
}
