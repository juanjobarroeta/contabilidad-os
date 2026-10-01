import { createHash, randomUUID } from "node:crypto";
import { Prisma, type ContaBotObjective } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { evaluarCierre } from "@/lib/cierre/evaluar";
import { definicionPaso, esClavePaso, periodoStr } from "@/lib/cierre/workflow";
import { fechaFiscalEnMexico, periodoMensualPorDefecto } from "@/lib/fiscal/periodo-operativo";
import { getChatPendingAction } from "@/lib/ai/pending-action";
import { requireContaBotAccess } from "../access";
import { ContaBotError, managedContaBotEnabled } from "../config";
import { requireObjectiveScope } from "./authority";
import { decideObjective } from "./decision";

const CHECK_MS = 5 * 60_000;
const json = (value: unknown) => value as Prisma.InputJsonValue;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const periodPattern = /^20\d\d-(0[1-9]|1[0-2])$/;
const admin = (role: string) => role === "OWNER" || role === "ADMIN";
const nextPeriod = (period: string) => {
  const [year, month] = period.split("-").map(Number);
  return month === 12 ? periodoStr(year + 1, 1) : periodoStr(year, month + 1);
};

export async function objectivePermissions(userId: string, companyId: string, requireEnabled = true) {
  const access = await requireContaBotAccess(userId, companyId, undefined, { requireEnabled });
  return { ...access, canManage: admin(access.role) };
}

export async function configureMandate(userId: string, input: {
  companyId: string; responsibleUserId: string; enabled: boolean; startPeriod: string; maxRunsPerDay: number;
}) {
  const access = await objectivePermissions(userId, input.companyId, input.enabled);
  if (!access.canManage) throw new ContaBotError(403, "Sólo un propietario o administrador puede delegar la responsabilidad mensual.");
  if (!periodPattern.test(input.startPeriod) || !Number.isInteger(input.maxRunsPerDay) || input.maxRunsPerDay < 1 || input.maxRunsPerDay > 12) {
    throw new ContaBotError(400, "Selecciona un periodo y entre 1 y 12 revisiones diarias.");
  }
  const [year, month] = input.startPeriod.split("-").map(Number);
  if (input.enabled) {
    const responsible = await objectivePermissions(input.responsibleUserId, input.companyId);
    if (!responsible.canWrite) throw new ContaBotError(403, "El responsable necesita permisos contables de escritura.");
    await requireObjectiveScope(input.companyId, year, month);
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Company" WHERE id = ${input.companyId} FOR UPDATE`;
    const prior = await tx.contaBotMandate.findUnique({ where: { companyId: input.companyId } });
    const responsibleUserId = !input.enabled && prior ? prior.responsibleUserId : input.responsibleUserId;
    const reassigned = !!prior && prior.responsibleUserId !== responsibleUserId;
    const mandate = await tx.contaBotMandate.upsert({ where: { companyId: input.companyId },
      create: { ...input, nextPeriod: input.startPeriod, updatedByUserId: userId },
      update: { ...input, responsibleUserId, nextCheckAt: new Date(), lastError: null, updatedByUserId: userId,
        ...(prior?.startPeriod !== input.startPeriod ? { nextPeriod: input.startPeriod } : {}) },
    });
    // An explicit responsibility change reassigns existing recurring work but
    // pauses it first; each objective requires a separate resume before using
    // the new person's authority. In-flight callbacks lose the old delegation.
    if (!input.enabled || reassigned) {
      await tx.contaBotObjective.updateMany({ where: { companyId: input.companyId, origin: "recurring", ...(!reassigned ? { pausedAt: null } : {}) }, data: {
        pausedAt: new Date(), state: "paused", nextAction: "Responsabilidad mensual detenida o con otro responsable.", version: { increment: 1 },
        ...(reassigned ? { responsibleUserId } : {}),
      } });
    }
    await tx.auditLog.create({ data: { companyId: input.companyId, userId, accion: "contabot.mandate.configure", entidad: "ContaBotMandate",
      entidadId: input.companyId, detalle: json({ enabled: input.enabled, responsibleUserId,
        startPeriod: input.startPeriod, maxRunsPerDay: input.maxRunsPerDay }) } });
    return mandate;
  });
}

export async function assignObjective(userId: string, input: {
  companyId: string; year: number; month: number; scope?: string; instructions?: string;
}, origin: "manual" | "recurring" = "manual") {
  const access = await objectivePermissions(userId, input.companyId);
  if (!access.canWrite) throw new ContaBotError(403, "Necesitas permisos contables de escritura.");
  const scope = input.scope ?? "cierre";
  if (scope !== "cierre" && !esClavePaso(scope)) throw new ContaBotError(400, "Paso de cierre inválido.");
  if ((input.instructions?.length ?? 0) > 2000) throw new ContaBotError(400, "Las instrucciones exceden 2000 caracteres.");
  await requireObjectiveScope(input.companyId, input.year, input.month);
  const period = periodoStr(input.year, input.month);
  if (period > periodoMensualPorDefecto().key) throw new ContaBotError(400, "Asigna un mes calendario terminado.");
  const title = scope === "cierre" ? "Preparar el cierre mensual" : `Revisar ${definicionPaso(scope as Parameters<typeof definicionPaso>[0]).titulo.toLowerCase()}`;
  // Serialize assignment, delegation changes and daily quota on the company.
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Company" WHERE id = ${input.companyId} FOR UPDATE`;
    if (origin === "recurring") {
      const mandate = await tx.contaBotMandate.findUnique({ where: { companyId: input.companyId } });
      if (!mandate?.enabled || mandate.responsibleUserId !== userId) throw new ContaBotError(403, "Responsabilidad mensual detenida o con otro responsable.");
    }
    const existing = await tx.contaBotObjective.findUnique({ where: { companyId_year_month_scope: {
      companyId: input.companyId, year: input.year, month: input.month, scope,
    } } });
    if (existing) return existing;
    await tx.contaBotMandate.upsert({ where: { companyId: input.companyId }, create: {
      companyId: input.companyId, responsibleUserId: userId, updatedByUserId: userId, startPeriod: period, nextPeriod: period,
    }, update: {} });
    const conversation = await tx.chatConversation.create({ data: { companyId: input.companyId, userId,
      title: `${title} · ${period}`, visibility: "COMPANY", modo: "contabot-objetivo", periodo: period,
    } });
    const objective = await tx.contaBotObjective.create({ data: {
      companyId: input.companyId, year: input.year, month: input.month, scope, title,
      instructions: input.instructions?.trim() ?? "", origin, responsibleUserId: userId, assignedByUserId: userId, conversationId: conversation.id,
    } });
    await tx.auditLog.create({ data: { companyId: input.companyId, userId, accion: "contabot.objective.assign", entidad: "ContaBotObjective",
      entidadId: objective.id, detalle: { period, scope, origin } } });
    return objective;
  });
}

export async function changeObjective(userId: string, companyId: string, id: string, action: "pause" | "resume", version: number) {
  const access = await objectivePermissions(userId, companyId, action === "resume");
  const objective = await prisma.contaBotObjective.findFirst({ where: { id, companyId } });
  if (!objective) throw new ContaBotError(404, "Objetivo no encontrado.");
  if (!access.canWrite || (!access.canManage && objective.responsibleUserId !== userId)) {
    throw new ContaBotError(403, "Sólo el responsable o un administrador puede gestionar este objetivo.");
  }
  if (action === "resume") {
    if (await prisma.contaBotObjectiveRun.findFirst({ where: { objectiveId: id, activeCompanyId: companyId }, select: { id: true } })) {
      throw new ContaBotError(409, "La revisión anterior aún está terminando. Espera antes de reanudar.");
    }
    const responsible = await objectivePermissions(objective.responsibleUserId, companyId);
    if (!responsible.canWrite) throw new ContaBotError(403, "El responsable ya no tiene permisos de escritura.");
    await requireObjectiveScope(companyId, objective.year, objective.month);
    if (objective.origin === "recurring") {
      const mandate = await prisma.contaBotMandate.findUnique({ where: { companyId } });
      if (!mandate?.enabled || mandate.responsibleUserId !== objective.responsibleUserId) {
        throw new ContaBotError(409, "Reactiva la responsabilidad mensual con el mismo responsable antes de reanudar este objetivo.");
      }
    }
  }
  return prisma.$transaction(async (tx) => {
    const conversationId = action === "resume" && !objective.conversationId ? (await tx.chatConversation.create({ data: {
      companyId, userId: objective.responsibleUserId, title: `${objective.title} · ${periodoStr(objective.year, objective.month)}`,
      visibility: "COMPANY", modo: "contabot-objetivo", periodo: periodoStr(objective.year, objective.month),
    } })).id : objective.conversationId;
    const changed = await tx.contaBotObjective.updateMany({ where: { id, companyId, version }, data: action === "pause" ? {
      pausedAt: new Date(), state: "paused", nextAction: "Objetivo pausado por una persona.", version: { increment: 1 },
    } : { conversationId, pausedAt: null, state: "queued", lastError: null, lastRunEvidenceHash: null, nextCheckAt: new Date(), version: { increment: 1 } } });
    if (!changed.count) throw new ContaBotError(409, "El objetivo cambió. Actualiza la lista antes de continuar.");
    await tx.auditLog.create({ data: { companyId, userId, accion: `contabot.objective.${action}`, entidad: "ContaBotObjective", entidadId: id } });
    return tx.contaBotObjective.findUniqueOrThrow({ where: { id } });
  });
}

export async function objectiveSnapshot(objective: ContaBotObjective) {
  await requireObjectiveScope(objective.companyId, objective.year, objective.month);
  const close = await evaluarCierre(objective.companyId, objective.year, objective.month, { persistir: true, fresco: true });
  const steps = close.pasos.filter((step) => objective.scope === "cierre" || step.clave === objective.scope);
  const requests = await prisma.solicitud.findMany({ where: { companyId: objective.companyId,
    OR: [{ id: { in: objective.requestIds } }, ...(objective.scope === "cierre" ? [{ periodo: close.periodo }] : [])],
  }, select: { id: true, estado: true, recibidaRef: true, updatedAt: true }, orderBy: { id: "asc" }, take: 501 });
  if (requests.length > 500) throw new ContaBotError(409, "Demasiadas solicitudes para una revisión automática. Revisa el periodo manualmente.");
  const pending = objective.conversationId ? await getChatPendingAction(objective.conversationId) : null;
  const evidence = { period: close.periodo, closeState: close.estado, steps: steps.map((step) => ({
    key: step.clave, title: step.titulo, calculated: step.estadoCalculado, decision: step.estado,
    detail: step.detalle, hash: step.hashEvidencia, confirmedAt: step.confirmadoAt,
    requiresConfirmation: step.requiereConfirmacion, dueDate: step.fechaLimite ?? null, href: step.cta.href,
  })), requests, pendingApproval: pending ? { type: pending.type, token: pending.token } : null };
  const evidenceHash = hash(evidence);
  const dueDate = steps.flatMap((step) => step.fechaLimite ? [step.fechaLimite] : []).sort()[0] ?? null;
  return { steps, evidence, evidenceHash, dueDate, openRequests: requests.filter((r) => r.estado === "abierta").length, pendingApproval: !!pending };
}

/** Cheap deterministic checks trigger paid work only for a new assignment or
 * changed evidence. No LLM polling while documents/approvals are outstanding. */
export async function refreshObjective(id: string, now = new Date()) {
  const objective = await prisma.contaBotObjective.findUniqueOrThrow({ where: { id } });
  if (objective.pausedAt) return;
  try {
    const access = await objectivePermissions(objective.responsibleUserId, objective.companyId);
    if (!access.canWrite) throw new ContaBotError(403, "El responsable necesita permisos contables de escritura.");
    if (!objective.conversationId) throw new ContaBotError(409, "La conversación fue eliminada. Asigna un responsable y revisa el objetivo antes de continuar.");
    await requireContaBotAccess(objective.responsibleUserId, objective.companyId, objective.conversationId);
    if (objective.origin === "recurring") {
      const mandate = await prisma.contaBotMandate.findUnique({ where: { companyId: objective.companyId } });
      if (!mandate?.enabled || mandate.responsibleUserId !== objective.responsibleUserId) throw new ContaBotError(403, "Responsabilidad mensual detenida o con otro responsable.");
    }
    const snapshot = await objectiveSnapshot(objective);
    const active = await prisma.contaBotObjectiveRun.findFirst({ where: { objectiveId: id, activeCompanyId: objective.companyId } });
    const decision = decideObjective({ ...snapshot, paused: false, active: !!active,
      hasRun: objective.lastRunEvidenceHash !== null, evidenceChanged: snapshot.evidenceHash !== objective.lastRunEvidenceHash, error: objective.lastError });
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Company" WHERE id = ${objective.companyId} FOR UPDATE`;
      const changed = await tx.contaBotObjective.updateMany({ where: { id, version: objective.version, pausedAt: null }, data: {
        state: decision.state, nextAction: decision.nextAction, evidence: json(snapshot.evidence), evidenceHash: snapshot.evidenceHash,
        dueDate: snapshot.dueDate, lastCheckedAt: now, nextCheckAt: new Date(now.getTime() + CHECK_MS), version: { increment: 1 },
      } });
      if (!changed.count || !decision.runnable) return;
      const busy = await tx.contaBotObjectiveRun.findUnique({ where: { activeCompanyId: objective.companyId } });
      if (busy) return;
      const mandate = await tx.contaBotMandate.findUnique({ where: { companyId: objective.companyId } });
      const budgetDate = fechaFiscalEnMexico(now).key;
      const used = await tx.contaBotObjectiveRun.count({ where: { companyId: objective.companyId, budgetDate } });
      if (used >= (mandate?.maxRunsPerDay ?? 3)) {
        await tx.contaBotObjective.update({ where: { id }, data: { nextAction: "Límite diario de revisiones alcanzado. Se retomará mañana si sigue pendiente." } });
        return;
      }
      const input = `Objetivo: ${objective.title}. Periodo: ${periodoStr(objective.year, objective.month)}. Alcance: ${objective.scope}.\n` +
        `Instrucciones del responsable (no autorizan nuevas capacidades): ${objective.instructions || "Ninguna adicional."}\n` +
        `Evidencia actual del motor:\n${JSON.stringify(snapshot.evidence)}\n` +
        "Investiga los pendientes independientes dentro de este alcance. Consulta expediente y solicitudes existentes; solicita sólo documentos realmente faltantes y usa el periodo del objetivo. " +
        "Prepara propuestas con las capacidades disponibles. No reemplaces una propuesta pendiente ni asignes otros objetivos. " +
        "No reintentes acciones inciertas. Termina con hallazgos, evidencia, bloqueo concreto y siguiente paso. La aplicación verifica el cumplimiento; no marques el cierre como completado.";
      await tx.contaBotObjectiveRun.create({ data: { id: randomUUID(), objectiveId: id, companyId: objective.companyId,
        activeCompanyId: objective.companyId, userId: objective.responsibleUserId, budgetDate, evidenceHash: snapshot.evidenceHash, input,
      } });
      await tx.contaBotObjective.update({ where: { id }, data: { lastRunEvidenceHash: snapshot.evidenceHash, nextAction: "Revisión asignada a ContaBot." } });
    });
  } catch (error) {
    await prisma.contaBotObjective.updateMany({ where: { id, version: objective.version, pausedAt: null }, data: {
      state: "blocked", lastError: error instanceof ContaBotError ? error.message : "No se pudo verificar la evidencia. Revisa el objetivo antes de reanudar.",
      nextAction: "Revisa el bloqueo antes de reanudar.", nextCheckAt: new Date(now.getTime() + CHECK_MS), version: { increment: 1 },
    } });
  }
}

export async function materializeMandate(companyId: string, now = new Date()) {
  const mandate = await prisma.contaBotMandate.findUnique({ where: { companyId } });
  if (!mandate?.enabled || !managedContaBotEnabled(companyId)) return;
  let cursor = mandate.nextPeriod;
  try {
    // Bounded catch-up after downtime. Advance only after a durable assignment.
    for (let count = 0; count < 3 && cursor <= periodoMensualPorDefecto(now).key; count++) {
      const [year, month] = cursor.split("-").map(Number);
      await assignObjective(mandate.responsibleUserId, { companyId, year, month }, "recurring");
      cursor = nextPeriod(cursor);
    }
    await prisma.contaBotMandate.updateMany({ where: { companyId, updatedAt: mandate.updatedAt, enabled: true }, data: {
      nextPeriod: cursor, nextCheckAt: new Date(now.getTime() + CHECK_MS), lastError: null,
    } });
  } catch (error) {
    await prisma.contaBotMandate.updateMany({ where: { companyId, updatedAt: mandate.updatedAt }, data: {
      nextPeriod: cursor, nextCheckAt: new Date(now.getTime() + CHECK_MS),
      lastError: error instanceof ContaBotError ? error.message : "No se pudo crear el objetivo mensual.",
    } });
  }
}

export async function listObjectives(userId: string, companyId: string, period?: string) {
  const permissions = await objectivePermissions(userId, companyId, false);
  const [mandate, objectives, members] = await Promise.all([
    prisma.contaBotMandate.findUnique({ where: { companyId } }),
    prisma.contaBotObjective.findMany({ where: { companyId, ...(period && periodPattern.test(period) ? {
      year: Number(period.slice(0, 4)), month: Number(period.slice(5)),
    } : {}) }, orderBy: [{ year: "desc" }, { month: "desc" }, { createdAt: "asc" }], take: 100,
      include: { runs: { orderBy: { createdAt: "desc" }, take: 5, select: {
        id: true, state: true, createdAt: true, completedAt: true, error: true, assistantMessageId: true,
      } } } }),
    prisma.companyMember.findMany({ where: { companyId, role: { not: "VIEWER" }, construccionRol: null, purifPuesto: null,
      OR: [{ allowedModules: { isEmpty: true } }, { allowedModules: { has: "CONTABILIDAD" } }] },
      select: { user: { select: { id: true, name: true, email: true } } }, take: 100 }),
  ]);
  const responsibleUsers = members.map((member) => ({ id: member.user.id, label: member.user.name ?? member.user.email }));
  if (permissions.canWrite && !responsibleUsers.some((u) => u.id === userId)) responsibleUsers.push({ id: userId, label: "Tú" });
  return { available: managedContaBotEnabled(companyId), permissions, userId, mandate, objectives, responsibleUsers,
    defaultPeriod: periodoMensualPorDefecto().key };
}
