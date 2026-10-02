import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { Prisma, type ContaBotSession } from "@prisma/client";
import type { AgentSession, AgentSessionItem } from "openai/resources/beta/agents/agents";
import { prisma } from "@/lib/prisma";
import { executeToolCall, type ToolContext } from "@/lib/ai/tool-executor";
import { ejecutarPresentacion, type Card } from "@/lib/copiloto/tarjetas";
import { allowedCapability, capabilityCatalogue, capabilityKind, managedTools, validateToolInput } from "./capabilities";
import { requireContaBotAccess, requireContaBotBudget } from "./access";
import { CONTABOT_MODEL, CONTABOT_CAPABILITY_VERSION, ContaBotError, MAX_TOOL_CALLS, MAX_TURN_MS, requireManagedConfig } from "./config";
import { ACCOUNTANT_INSTRUCTIONS, agentClient, estimatedCostMicroUsd, textFromItems } from "./provider";
import { requireObjectiveAuthority, settleObjectiveRun } from "./objectives/authority";
import { getChatPendingAction } from "@/lib/ai/pending-action";

const LEASE_MS = 5 * 60_000;
const json = (value: unknown) => value as Prisma.InputJsonValue;
type Client = ReturnType<typeof agentClient>;
type FunctionAction = AgentSession.SessionRequiredActionResourceFunctionCall;

export interface StartTurn {
  conversationId: string;
  companyId: string;
  userId: string;
  requestId: string;
  text: string;
  instructions: string;
  context?: ToolContext;
  ref?: unknown;
  /** Turno automático tras confirmar una tarjeta: el mensaje del usuario no se pinta. */
  seguimiento?: boolean;
  objectiveRunId?: string;
}

/** Claim the company before any inference; persist the user's input first. */
export async function beginManagedTurn(input: StartTurn): Promise<ContaBotSession> {
  requireManagedConfig();
  await requireContaBotAccess(input.userId, input.companyId, input.conversationId);
  await requireContaBotBudget(input.userId, input.companyId);
  await requireObjectiveAuthority({ ...input, objectiveRunId: input.objectiveRunId ?? null });
  try {
    return await prisma.$transaction(async (tx) => {
      const session = await tx.contaBotSession.upsert({
        where: { conversationId_userId: { conversationId: input.conversationId, userId: input.userId } },
        create: { conversationId: input.conversationId, companyId: input.companyId, userId: input.userId, model: CONTABOT_MODEL },
        update: {},
      });
      if (session.requestId === input.requestId) {
        if (session.input !== input.text) throw new ContaBotError(409, "La solicitud ya existe con otro contenido.");
        return session;
      }
      const claim = await tx.contaBotSession.updateMany({
        where: { id: session.id, state: "idle" },
        data: { state: "starting", activeCompanyId: input.companyId, activeConversationId: input.conversationId },
      });
      if (!claim.count) throw new ContaBotError(409, "ContaBot sigue trabajando en esta conversación. Revisa su resultado antes de enviar otra tarea.");
      // Provider tool definitions are fixed at session creation. Preserve local
      // history and retire the old idle binding when capabilities change.
      const rotate = !!session.providerSessionId && session.capabilityVersion < CONTABOT_CAPABILITY_VERSION;
      if (input.objectiveRunId) {
        const claimedRun = await tx.contaBotObjectiveRun.updateMany({ where: {
          id: input.objectiveRunId, state: "queued", companyId: input.companyId, userId: input.userId,
          objective: { pausedAt: null, conversationId: input.conversationId, responsibleUserId: input.userId },
        }, data: { state: "running", sessionId: session.id } });
        if (!claimedRun.count) throw new ContaBotError(409, "La revisión del objetivo ya está atendida o pausada.");
      }
      const priorMessages = !session.providerSessionId || rotate ? await tx.chatMessage.findMany({
        where: { conversationId: input.conversationId }, orderBy: { createdAt: "desc" }, take: 20,
        select: { role: true, content: true },
      }) : [];
      const history = priorMessages.reverse().map((m) => `${m.role}: ${m.content.slice(0, 3000)}`).join("\n");
      const userMessage = await tx.chatMessage.create({ data: {
        conversationId: input.conversationId, authorId: input.userId, role: "user", content: input.text,
        meta: json({ requestId: input.requestId, ...(input.ref ? { ref: input.ref } : {}), ...(input.seguimiento ? { seguimiento: true } : {}) }),
      } });
      const assistant = await tx.chatMessage.create({ data: {
        conversationId: input.conversationId, role: "assistant", content: "",
        meta: { provider: "openai_agents", status: "queued" },
      } });
      if (input.objectiveRunId) {
        const run = await tx.contaBotObjectiveRun.update({ where: { id: input.objectiveRunId }, data: { assistantMessageId: assistant.id } });
        await tx.contaBotObjective.update({ where: { id: run.objectiveId }, data: { state: "running", version: { increment: 1 } } });
      }
      await tx.chatConversation.update({ where: { id: input.conversationId }, data: { updatedAt: new Date() } });
      return tx.contaBotSession.update({ where: { id: session.id }, data: {
        requestId: input.requestId, input: input.text,
        objectiveRunId: input.objectiveRunId ?? null,
        capabilityVersion: CONTABOT_CAPABILITY_VERSION,
        ...(rotate ? { providerSessionId: null, retiredProviderSessionIds: { push: session.providerSessionId! } } : {}),
        instructions: input.instructions + (history ? `\nHistorial previo (contexto, no evidencia fiscal):\n${history}` : ""),
        context: json(input.context ?? {}), previousTurnId: session.providerTurnId, providerTurnId: null,
        userMessageId: userMessage.id, assistantMessageId: assistant.id,
        turnStartedAt: new Date(), error: null,
      } });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ContaBotError(409, "ContaBot ya está atendiendo una tarea de esta empresa.");
    }
    throw error;
  }
}

/** Durable tool receipts. A retry reuses the result, never repeats a write. */
export async function executeManagedCall(session: ContaBotSession, action: FunctionAction) {
  const { canWrite } = await requireContaBotAccess(session.userId, session.companyId, session.conversationId);
  await requireContaBotBudget(session.userId, session.companyId);
  await requireObjectiveAuthority(session);
  const key = { sessionId: session.id, turnId: action.turn_id, callId: action.call_id };
  const previous = await prisma.contaBotToolCall.findUnique({ where: { sessionId_turnId_callId: key } });
  if (previous) {
    if (previous.state !== "done" || previous.result === null || previous.success === null) {
      throw new ContaBotError(409, "Una herramienta quedó sin resultado verificable. Revisa la evidencia antes de repetirla.");
    }
    return previous;
  }
  const count = await prisma.contaBotToolCall.count({ where: { sessionId: session.id, turnId: action.turn_id } });
  if (count >= MAX_TOOL_CALLS) throw new ContaBotError(429, "ContaBot alcanzó el límite de herramientas de esta tarea.");
  const receipt = await prisma.contaBotToolCall.create({ data: {
    ...key, name: action.name, arguments: json(action.arguments ?? {}),
  } });
  let success = true;
  let result: string;
  let card: Card | undefined;
  let effectStarted = false;
  try {
    if (action.name !== "consultar_capacidades" && !allowedCapability(action.name, canWrite)) {
      throw new Error("TOOL_NOT_AUTHORIZED");
    }
    const args = await validateToolInput(action.name, action.arguments);
    if (session.objectiveRunId && action.name === "asignar_objetivo_cierre") throw new Error("TOOL_NOT_AUTHORIZED: objectives cannot delegate new work");
    if (session.objectiveRunId && capabilityKind(action.name) === "proposal" && await getChatPendingAction(session.conversationId)) {
      throw new Error("TOOL_NOT_AUTHORIZED: a proposal already awaits human confirmation");
    }
    if (action.name === "consultar_capacidades") {
      result = JSON.stringify(capabilityCatalogue(canWrite));
    } else if (action.name === "consultar_objetivos" || action.name === "asignar_objetivo_cierre") {
      effectStarted = action.name === "asignar_objetivo_cierre";
      const { executeObjectiveTool } = await import("./objectives/tools-executor");
      result = await executeObjectiveTool(action.name, args, session.userId, session.companyId);
    } else if (capabilityKind(action.name) === "presentation") {
      const rendered = ejecutarPresentacion(action.name, args);
      result = rendered.resultado;
      card = rendered.card ?? undefined;
    } else {
      effectStarted = ["memory", "proposal"].includes(capabilityKind(action.name) ?? "");
      const context = (session.context ?? {}) as ToolContext;
      result = await executeToolCall(action.name, args, session.companyId, {
        cierre: context.cierre, conversationId: session.conversationId,
        userId: session.userId, inApp: canWrite, origen: "copiloto",
      });
      if (action.name === "anotar_expediente" && JSON.parse(result).nota_id && typeof args.titulo === "string") {
        card = { type: "memoria", texto: args.titulo.slice(0, 200) };
      }
      if (session.objectiveRunId && action.name === "solicitar_al_cliente") {
        const requestId = JSON.parse(result).solicitud_id;
        if (typeof requestId === "string" && await prisma.solicitud.findFirst({ where: { id: requestId, companyId: session.companyId }, select: { id: true } })) {
          const run = await prisma.contaBotObjectiveRun.findUniqueOrThrow({ where: { id: session.objectiveRunId } });
          await prisma.contaBotObjective.updateMany({ where: { id: run.objectiveId, NOT: { requestIds: { has: requestId } } },
            data: { requestIds: { push: requestId } } });
        }
      }
    }
    if (Buffer.byteLength(result, "utf8") > 150_000) {
      success = false;
      result = "RESULT_TOO_LARGE: narrow the query with dates, IDs or a smaller limit. No complete result was returned.";
    }
  } catch (error) {
    if (effectStarted) {
      await prisma.contaBotToolCall.update({ where: { id: receipt.id }, data: { state: "uncertain" } });
      throw new ContaBotError(409, "No se pudo verificar una escritura del agente. Se detuvo la tarea para evitar repetirla.");
    }
    // Only known argument/authorization failures are safe to return verbatim.
    // Domain exceptions may contain bank data, SQL or provider credentials.
    success = false;
    result = error instanceof Error && /^(TOOL_NOT_|INVALID_)/.test(error.message)
      ? error.message : "TOOL_FAILED: no verified result. Inspect the current state before proposing another action.";
  }
  return prisma.contaBotToolCall.update({ where: { id: receipt.id }, data: {
    state: "done", success, result, ...(card ? { card: json(card) } : {}), completedAt: new Date(),
  } });
}

async function submit(session: ContaBotSession, client: Client): Promise<ContaBotSession> {
  const { canWrite } = await requireContaBotAccess(session.userId, session.companyId, session.conversationId);
  await requireContaBotBudget(session.userId, session.companyId);
  await requireObjectiveAuthority(session);
  const input = `[Solicitud ${session.requestId}]\n${session.instructions ?? ""}\n\n${session.input ?? ""}`;
  if (session.providerSessionId) {
    await client.beta.agents.sessions.events.create(session.providerSessionId, {
      "Idempotency-Key": `contabot:${session.id}:${session.requestId}`,
      events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: input }] }] }],
    });
    return prisma.contaBotSession.update({ where: { id: session.id }, data: { state: "working" } });
  }
  // Commit the attempt before the network boundary. A timeout is ambiguous and
  // must be recovered using metadata/webhooks, never another create request.
  await prisma.contaBotSession.update({ where: { id: session.id }, data: { state: "creating" } });
  try {
    const remote = await client.beta.agents.sessions.create({
      agent: { model: session.model, instructions: ACCOUNTANT_INSTRUCTIONS,
        tools: managedTools(canWrite), multi_agent: { enabled: false }, service_tier: "default" },
      environment: { type: "none" }, input,
      metadata: { contabot_session: session.id },
    });
    return prisma.contaBotSession.update({ where: { id: session.id }, data: {
      providerSessionId: remote.id, state: "working",
    } });
  } catch (error) {
    const rejected = error instanceof OpenAI.APIError && error.status !== undefined &&
      error.status >= 400 && error.status < 500 && error.status !== 408;
    const message = rejected ? "El proveedor rechazó la sesión. Revisa permisos y configuración de la API."
      : "Se está verificando si el proveedor recibió la tarea; no se enviará una copia.";
    await prisma.contaBotSession.update({ where: { id: session.id }, data: {
      state: rejected ? "idle" : "uncertain",
      ...(rejected ? { activeCompanyId: null, activeConversationId: null } : {}),
      error: message,
    } });
    await prisma.chatMessage.update({ where: { id: session.assistantMessageId! }, data: { content: message,
      meta: { provider: "openai_agents", status: rejected ? "failed" : "uncertain" } } });
    if (rejected) await prisma.$transaction((tx) => settleObjectiveRun(tx, session, message, true));
    throw new ContaBotError(503, "No se pudo iniciar el agente. La solicitud quedó registrada.");
  }
}

async function recoverCreation(session: ContaBotSession, client: Client) {
  // Bounded scan; unknown remains unknown. Never infer that a session wasn't
  // created merely because it is absent from one page of provider results.
  let inspected = 0;
  for await (const remote of client.beta.agents.sessions.list({ order: "desc", limit: 100 })) {
    if (remote.metadata.contabot_session === session.id && !session.retiredProviderSessionIds.includes(remote.id)) {
      return prisma.contaBotSession.update({ where: { id: session.id }, data: {
        providerSessionId: remote.id, state: "working", error: null,
      } });
    }
    if (++inspected >= 300) break;
  }
  return session;
}

async function recordUsage(session: ContaBotSession, turnId: string, usage: AgentSession["usage"]) {
  const amount = estimatedCostMicroUsd(usage);
  if (amount === null) return false;
  const id = `contabot:${session.id}:${turnId}`;
  const data = {
    categoria: "OPENAI", subtipo: "contabot.managed", companyId: session.companyId, userId: session.userId,
    unidades: usage!.input_tokens + usage!.output_tokens, costoMicroUsd: amount,
    meta: json({ model: session.model, usage, estimate: "conservative_long_context", providerTurnId: turnId }),
    occurredAt: session.turnStartedAt ?? new Date(),
  };
  await prisma.costEvent.upsert({ where: { id }, create: { id, ...data }, update: data });
  return true;
}

async function readTurnItems(client: Client, providerId: string, turnId: string) {
  const items: AgentSessionItem[] = [];
  // Fetch every page: an older item can arrive late, so do not assume history is
  // contiguous by turn. The SDK carries the exclusive pagination cursor.
  for await (const item of client.beta.agents.sessions.items.list(providerId, { order: "desc", limit: 100 })) {
    if (item.turn_id === turnId) items.push(item);
  }
  return items.reverse();
}

async function stop(session: ContaBotSession, client: Client, reason: string) {
  // Stop local capabilities first, even if the provider's cancellation request
  // fails. Recovery retries the cancellation; this is not terminal evidence.
  await prisma.contaBotSession.update({ where: { id: session.id }, data: { state: "blocked", error: reason } });
  if (session.providerSessionId) {
    await client.beta.agents.sessions.events.create(session.providerSessionId, {
      "Idempotency-Key": `contabot:cancel:${session.id}:${session.requestId}`,
      events: [{ type: "agent.session.input.cancel" }],
    });
  }
}

/** One bounded synchronization pass. Webhooks, initial submission and recovery cron
 * all use the same database lease and durable receipts. This is a transport
 * adapter; OpenAI owns the model loop and conversation compaction. */
export async function syncManagedSession(id: string): Promise<boolean> {
  const leaseToken = randomUUID();
  const acquired = await prisma.contaBotSession.updateMany({ where: {
    id, state: { notIn: ["idle", "deleting"] },
    OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: new Date() } }],
  }, data: { leaseToken, leaseExpiresAt: new Date(Date.now() + LEASE_MS) } });
  if (!acquired.count) return false;
  const client = agentClient();
  try {
    let session = await prisma.contaBotSession.findUniqueOrThrow({ where: { id } });
    if (session.state === "starting") {
      try { session = await submit(session, client); }
      catch (error) {
        if (error instanceof ContaBotError) {
          // Only a still-unsubmitted row may be released here. Creation errors
          // have already moved it to idle/uncertain and must retain that state.
          const stopped = await prisma.contaBotSession.updateMany({ where: { id, state: "starting" }, data: {
            state: "idle", activeCompanyId: null, activeConversationId: null, error: error.message,
          } });
          if (stopped.count) {
            await prisma.chatMessage.update({ where: { id: session.assistantMessageId! }, data: { content: error.message } });
            await prisma.$transaction((tx) => settleObjectiveRun(tx, session, error.message, true));
          }
        }
        throw error;
      }
    }
    if (!session.providerSessionId) session = await recoverCreation(session, client);
    if (!session.providerSessionId) return true;
    const remote = await client.beta.agents.sessions.retrieve(session.providerSessionId);
    if (remote.metadata.contabot_session !== session.id) throw new Error("Provider session binding mismatch");
    const turns = await client.beta.agents.sessions.turns.list(remote.id, { order: "desc", limit: 10 });
    const newest = turns.data.find((t) => t.subagent_id === null);
    const turn = session.providerTurnId
      ? await client.beta.agents.sessions.turns.retrieve(session.providerTurnId, { session_id: remote.id })
      : newest && newest.id !== session.previousTurnId ? newest : undefined;
    if (!turn) {
      // An idle session alone says nothing about acceptance or completion.
      if (remote.status === "failed" || Date.now() - session.turnStartedAt!.getTime() > MAX_TURN_MS) {
        const reason = "No se pudo verificar el inicio de la tarea. Se detuvo la sesión; revisa su estado antes de reintentar.";
        await stop(session, client, reason);
        await prisma.chatMessage.update({ where: { id: session.assistantMessageId! }, data: { content: reason } });
      }
      return true;
    }
    session = await prisma.contaBotSession.update({ where: { id }, data: { providerTurnId: turn.id } });
    const costKnown = await recordUsage(session, turn.id, turn.usage);
    const terminal = ["completed", "failed", "cancelled"].includes(turn.status);
    if (!terminal) {
      try {
        await requireContaBotAccess(session.userId, session.companyId, session.conversationId);
        await requireContaBotBudget(session.userId, session.companyId);
        await requireObjectiveAuthority(session);
        if (session.state === "blocked") throw new ContaBotError(409, session.error ?? "Tarea detenida.");
        if (Date.now() - session.turnStartedAt!.getTime() > MAX_TURN_MS) {
          throw new ContaBotError(408, "La tarea alcanzó su tiempo máximo. Revisa el avance antes de continuar.");
        }
        for (const action of remote.required_actions.slice(0, 3)) {
          if (action.type !== "function_call" || action.turn_id !== turn.id) {
            throw new ContaBotError(409, "El agente pidió una capacidad no habilitada.");
          }
          const receipt = await executeManagedCall(session, action);
          await client.beta.agents.sessions.events.create(remote.id, {
            "Idempotency-Key": `contabot:tool:${receipt.id}`,
            events: [{ type: "agent.session.input.tool_result", turn_id: action.turn_id, call_id: action.call_id,
              ...(receipt.success ? { success: true, output: receipt.result! } : { success: false, error: receipt.result! }) }],
          });
        }
      } catch (error) {
        if (!(error instanceof ContaBotError)) throw error;
        await stop(session, client, error.message);
      }
      return true;
    }
    const items = await readTurnItems(client, remote.id, turn.id);
    const calls = await prisma.contaBotToolCall.findMany({ where: { sessionId: id, turnId: turn.id }, orderBy: { createdAt: "asc" } });
    const cards = calls.flatMap((call) => call.card ? [call.card] : []);
    const content = textFromItems(items, turn.id);
    const error = session.error ?? (turn.status !== "completed" ? "La tarea se detuvo antes de completarse." : null);
    await prisma.$transaction(async (tx) => {
      await tx.chatMessage.update({ where: { id: session.assistantMessageId! }, data: {
        content: error ? `${content}${content ? "\n\n" : ""}${error}` : content || "La tarea terminó sin una respuesta verificable.",
        cards: json(cards), meta: json({ provider: "openai_agents", status: error ? "interrupted" : turn.status,
          providerTurnId: turn.id, usageKnown: costKnown, tools: calls.map((call) => ({ name: call.name, success: call.success })) }),
      } });
      await tx.contaBotSession.update({ where: { id }, data: {
        // Unknown usage blocks another paid turn until accounting arrives.
        state: costKnown ? "idle" : "usage_pending",
        activeCompanyId: costKnown ? null : session.companyId, activeConversationId: null,
      } });
      await tx.chatConversation.update({ where: { id: session.conversationId }, data: { updatedAt: new Date() } });
      await settleObjectiveRun(tx, session, error, costKnown);
    });
    return true;
  } finally {
    // Fencing: an expired worker must not unlock a newer lease.
    await prisma.contaBotSession.updateMany({ where: { id, leaseToken }, data: {
      leaseToken: null, leaseExpiresAt: null, lastSyncedAt: new Date(),
    } });
  }
}

export async function syncProviderSession(providerId: string) {
  const client = agentClient();
  const remote = await client.beta.agents.sessions.retrieve(providerId);
  const id = remote.metadata.contabot_session;
  if (!id) return;
  const local = await prisma.contaBotSession.findUnique({ where: { id } });
  if (local?.retiredProviderSessionIds.includes(providerId)) return;
  if (!local || (local.providerSessionId && local.providerSessionId !== providerId)) return;
  if (!local.providerSessionId && ["creating", "uncertain"].includes(local.state)) {
    await prisma.contaBotSession.updateMany({ where: { id, providerSessionId: null }, data: {
      providerSessionId: providerId, state: "working", error: null,
    } });
  }
  await syncManagedSession(id);
}

/** Remove provider history before local deletion. A failed delete stays
 * retryable; never orphan a durable agent by only deleting its UI messages. */
export async function deleteManagedSessions(conversationId: string) {
  // Deleting a chat revokes its delegation before touching provider history.
  // A scheduled assignment must not silently recreate deleted conversations.
  await prisma.contaBotObjective.updateMany({ where: { conversationId }, data: {
    pausedAt: new Date(), state: "paused", nextAction: "Conversación eliminada; objetivo detenido.", version: { increment: 1 },
  } });
  const sessions = await prisma.contaBotSession.findMany({ where: { conversationId } });
  if (!sessions.length) return;
  for (const session of sessions) {
    if (["creating", "uncertain"].includes(session.state) && !session.providerSessionId) {
      throw new ContaBotError(409, "Primero debe recuperarse la sesión pendiente del agente.");
    }
    const claimed = await prisma.contaBotSession.updateMany({ where: {
      id: session.id, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: new Date() } }],
    }, data: { state: "deleting" } });
    if (!claimed.count) throw new ContaBotError(409, "El agente está guardando su avance. Inténtalo de nuevo.");
    for (const providerId of [...session.retiredProviderSessionIds, ...(session.providerSessionId ? [session.providerSessionId] : [])]) {
      try { await agentClient().beta.agents.sessions.delete(providerId); }
      catch (error) { if (!(error instanceof OpenAI.NotFoundError)) throw error; }
    }
    await prisma.$transaction((tx) => settleObjectiveRun(tx, session, "Conversación eliminada; revisión detenida.", true));
  }
}
