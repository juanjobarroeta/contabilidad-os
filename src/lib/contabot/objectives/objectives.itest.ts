import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "openai/resources/beta/agents/agents";
import type { CierreEvaluado, PasoConDecision } from "@/lib/cierre/evaluar";
vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/ai/guardia", () => ({ estadoIAEmpresa: async () => ({ gastoMesUsd: 0, topeMesUsd: 100 }), asegurarUsoIA: async () => ({ ok: true }) }));
vi.mock("@/lib/subscription", () => ({ gateEscritura: async () => null }));
vi.mock("@/lib/cierre/evaluar", () => ({ evaluarCierre: vi.fn(), invalidarCierre: vi.fn() }));
vi.mock("../provider", async (original) => ({ ...await original<object>(), agentClient: vi.fn() }));
import { prisma } from "@/lib/prisma";
import { evaluarCierre } from "@/lib/cierre/evaluar";
import { agentClient } from "../provider";
import { beginManagedTurn, executeManagedCall, syncManagedSession } from "../runtime";
import { assignObjective, changeObjective, configureMandate, listObjectives, materializeMandate, refreshObjective } from "./service";
import { startObjectiveRun } from "./worker";
import { requireObjectiveAuthority } from "./authority";

const A = "itest-objective-a", B = "itest-objective-b", U = "itest-objective-owner", V = "itest-objective-viewer";
const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
let close: CierreEvaluado, remote: AgentSession, turn: { id: string; subagent_id: null; status: string; usage: typeof usage | null };
let api: ReturnType<typeof agentClient>;
async function assign(scope = "banco") { return assignObjective(U, { companyId: A, year: 2026, month: 8, scope }); }
async function queued(objectiveId: string) {
  await refreshObjective(objectiveId);
  return prisma.contaBotObjectiveRun.findFirstOrThrow({ where: { objectiveId, state: "queued" } });
}
async function cleanup() {
  await prisma.costEvent.deleteMany({ where: { companyId: { in: [A, B] } } });
  await prisma.company.deleteMany({ where: { id: { in: [A, B] } } });
  await prisma.user.deleteMany({ where: { id: { in: [U, V] } } });
}
describe.skipIf(process.env.DB_TESTS_SKIP === "1")("ContaBot delegated objectives with Postgres and synthetic provider", () => {
  beforeAll(async () => {
    await cleanup();
    vi.stubEnv("CONTABOT_MANAGED_ENABLED", "1"); vi.stubEnv("CONTABOT_MANAGED_COMPANY_IDS", `${A},${B}`);
    vi.stubEnv("OPENAI_API_KEY", "synthetic-key"); vi.stubEnv("CONTABOT_OPENAI_WEBHOOK_SECRET", "synthetic-secret");
    await prisma.user.createMany({ data: [{ id: U, email: "objectives-owner@test.local", esOperador: true }, { id: V, email: "objectives-viewer@test.local" }] });
    await prisma.company.createMany({ data: [A, B].map((id, index) => ({ id, rfc: `OBJ26080${index}AA1`, razonSocial: id, regimenFiscal: "601", codigoPostal: "06600", tier: "PRO" })) });
    await prisma.companyMember.createMany({ data: [{ companyId: A, userId: U, role: "OWNER" }, { companyId: A, userId: V, role: "VIEWER" }] });
  });
  afterAll(async () => { await cleanup(); vi.unstubAllEnvs(); });
  beforeEach(async () => {
    await prisma.contaBotObjective.deleteMany({ where: { companyId: A } });
    await prisma.contaBotMandate.deleteMany({ where: { companyId: A } });
    await prisma.chatConversation.deleteMany({ where: { companyId: A } });
    await prisma.solicitud.deleteMany({ where: { companyId: A } });
    await prisma.companyRegimen.deleteMany({ where: { companyId: A } });
    await prisma.companyMember.updateMany({ where: { companyId: A, userId: U }, data: { role: "OWNER", allowedModules: [] } });
    await prisma.companyMember.updateMany({ where: { companyId: A, userId: V }, data: { role: "VIEWER", allowedModules: [] } });
    const steps = ["banco", "sat"].map((clave) => ({ clave, titulo: clave, estadoCalculado: "bloquea", estado: "PENDIENTE", requiereConfirmacion: true,
      hashEvidencia: "evidence-v1", confirmadoAt: null, detalle: "Falta evidencia", cta: { href: "/bancos", label: "Revisar" } } as PasoConDecision));
    close = { companyId: A, year: 2026, month: 8, periodo: "2026-08", pasos: steps, estado: {} } as CierreEvaluado;
    vi.mocked(evaluarCierre).mockReset().mockImplementation(async () => close);
    turn = { id: `turn_${Date.now()}`, subagent_id: null, status: "waiting", usage };
    remote = { id: `provider_${Date.now()}`, metadata: {}, required_actions: [], status: "requires_action" } as unknown as AgentSession;
    const sessions = {
      create: vi.fn(async (body) => { remote.metadata = body.metadata; return remote; }), retrieve: vi.fn(async () => remote),
      delete: vi.fn(), list: vi.fn(async function* () { yield remote; }),
      turns: { list: vi.fn(async () => ({ data: [turn] })), retrieve: vi.fn(async () => turn) },
      items: { list: vi.fn(async function* () {}) }, events: { create: vi.fn(async () => undefined) },
    };
    api = { beta: { agents: { sessions } } } as unknown as ReturnType<typeof agentClient>;
    vi.mocked(agentClient).mockReturnValue(api);
  });

  it("denies viewers, operator bypass, foreign assignees and mixed regimes before accounting reads", async () => {
    await expect(assignObjective(V, { companyId: A, year: 2026, month: 8 })).rejects.toMatchObject({ status: 403 });
    await expect(assignObjective(U, { companyId: B, year: 2026, month: 8 })).rejects.toMatchObject({ status: 403 });
    await expect(configureMandate(U, { companyId: A, responsibleUserId: V, enabled: true, startPeriod: "2026-08", maxRunsPerDay: 3 })).rejects.toMatchObject({ status: 403 });
    await prisma.companyRegimen.createMany({ data: [{ companyId: A, code: "601", label: "General PM" }, { companyId: A, code: "603", label: "Sin fines de lucro" }] });
    await expect(assign()).rejects.toMatchObject({ status: 422 });
    expect(evaluarCierre).not.toHaveBeenCalled();
    expect(await prisma.contaBotObjective.count({ where: { companyId: A } })).toBe(0);
  });

  it("deduplicates concurrent assignments and daily work, including restart before provider submission", async () => {
    const [one, two] = await Promise.all([assign(), assign()]);
    expect(one.id).toBe(two.id);
    await Promise.all([refreshObjective(one.id), refreshObjective(one.id)]);
    const runs = await prisma.contaBotObjectiveRun.findMany({ where: { objectiveId: one.id } });
    expect(runs).toHaveLength(1);
    const run = runs[0];
    const session = await beginManagedTurn({ companyId: A, userId: U, conversationId: one.conversationId!, requestId: run.id,
      objectiveRunId: run.id, text: run.input, instructions: "synthetic" });
    expect(api.beta.agents.sessions.create).not.toHaveBeenCalled();
    await syncManagedSession(session.id);
    await startObjectiveRun(run.id);
    expect(api.beta.agents.sessions.create).toHaveBeenCalledTimes(1);
    expect(await prisma.chatMessage.count({ where: { conversationId: one.conversationId!, role: "user" } })).toBe(1);
  });

  it("waits for documents, resumes once they arrive, and never treats a finished model turn as completion", async () => {
    const objective = await assign(); const run = await queued(objective.id); await startObjectiveRun(run.id);
    const session = await prisma.contaBotSession.findFirstOrThrow({ where: { objectiveRunId: run.id } });
    await executeManagedCall(session, { type: "function_call", name: "solicitar_al_cliente", turn_id: turn.id, call_id: "missing-statement", arguments: {
      tipo: "estado_cuenta_banco", detalle: "Estado bancario sintético de agosto", periodo: "2026-08", refs: ["synthetic-bank"],
    } });
    turn.status = "completed"; await syncManagedSession(session.id);
    await refreshObjective(objective.id);
    expect((await prisma.contaBotObjective.findUniqueOrThrow({ where: { id: objective.id } })).state).toBe("waiting_documents");
    await refreshObjective(objective.id);
    expect(await prisma.contaBotObjectiveRun.count({ where: { objectiveId: objective.id } })).toBe(1);
    await prisma.solicitud.updateMany({ where: { companyId: A }, data: { estado: "recibida", recibidaRef: "synthetic-file" } });
    await refreshObjective(objective.id);
    expect(await prisma.contaBotObjectiveRun.count({ where: { objectiveId: objective.id } })).toBe(2);
    expect((await prisma.contaBotObjective.findUniqueOrThrow({ where: { id: objective.id } })).state).not.toBe("completed");
  });

  it("blocks callbacks after a pause and keeps the pause through terminal settlement", async () => {
    const objective = await assign(); const run = await queued(objective.id); await startObjectiveRun(run.id);
    const current = await prisma.contaBotObjective.findUniqueOrThrow({ where: { id: objective.id } });
    await changeObjective(U, A, objective.id, "pause", current.version);
    const session = await prisma.contaBotSession.findFirstOrThrow({ where: { objectiveRunId: run.id } });
    await expect(requireObjectiveAuthority(session)).rejects.toMatchObject({ status: 403 });
    await syncManagedSession(session.id);
    expect(api.beta.agents.sessions.events.create).toHaveBeenCalledWith(remote.id, expect.objectContaining({ events: [{ type: "agent.session.input.cancel" }] }));
    turn.status = "cancelled"; await syncManagedSession(session.id);
    expect((await prisma.contaBotObjective.findUniqueOrThrow({ where: { id: objective.id } })).state).toBe("paused");
    expect((await prisma.contaBotObjectiveRun.findUniqueOrThrow({ where: { id: run.id } })).activeCompanyId).toBeNull();
  });

  it("retains its company lock until usage arrives, then preserves the receipt across later chat turns", async () => {
    const objective = await assign(); const run = await queued(objective.id); await startObjectiveRun(run.id);
    const session = await prisma.contaBotSession.findFirstOrThrow({ where: { objectiveRunId: run.id } });
    turn.status = "completed"; turn.usage = null; await syncManagedSession(session.id);
    expect((await prisma.contaBotObjectiveRun.findUniqueOrThrow({ where: { id: run.id } })).state).toBe("running");
    turn.usage = usage; await syncManagedSession(session.id);
    const receipt = await prisma.contaBotObjectiveRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(receipt.state).toBe("succeeded");
    await beginManagedTurn({ companyId: A, userId: U, conversationId: objective.conversationId!, requestId: "next-human-message", text: "Explain findings", instructions: "synthetic" });
    expect(await prisma.contaBotObjectiveRun.findUniqueOrThrow({ where: { id: run.id } })).toEqual(receipt);
  });

  it("enforces one company-wide daily cap and reopens verified objectives when evidence changes", async () => {
    await configureMandate(U, { companyId: A, responsibleUserId: U, enabled: false, startPeriod: "2026-08", maxRunsPerDay: 1 });
    const objective = await assign(); const run = await queued(objective.id); await startObjectiveRun(run.id);
    const session = await prisma.contaBotSession.findFirstOrThrow({ where: { objectiveRunId: run.id } });
    turn.status = "completed"; await syncManagedSession(session.id);
    close.pasos[0] = { ...close.pasos[0], estadoCalculado: "listo", estado: "CONFIRMADO", hashEvidencia: "evidence-v2" };
    await refreshObjective(objective.id);
    expect((await prisma.contaBotObjective.findUniqueOrThrow({ where: { id: objective.id } })).state).toBe("completed");
    close.pasos[0] = { ...close.pasos[0], estadoCalculado: "sin_datos", estado: "REVISAR", hashEvidencia: "evidence-v3" };
    const other = await assign("sat");
    await Promise.all([refreshObjective(objective.id), refreshObjective(other.id)]);
    expect(await prisma.contaBotObjectiveRun.count({ where: { companyId: A } })).toBe(1);
    expect((await prisma.contaBotObjective.findUniqueOrThrow({ where: { id: objective.id } })).state).toBe("queued");
    expect((await prisma.contaBotObjective.findUniqueOrThrow({ where: { id: other.id } })).nextAction).toContain("Límite diario");
  });

  it("materializes monthly responsibilities once, and disabling cancels queued delegation", async () => {
    await configureMandate(U, { companyId: A, responsibleUserId: U, enabled: true, startPeriod: "2026-08", maxRunsPerDay: 3 });
    const now = new Date("2026-09-20T12:00:00Z");
    await Promise.all([materializeMandate(A, now), materializeMandate(A, now)]);
    const list = await listObjectives(U, A);
    expect(list.objectives).toHaveLength(1); expect(list.objectives[0].origin).toBe("recurring");
    const run = await queued(list.objectives[0].id);
    await configureMandate(U, { companyId: A, responsibleUserId: U, enabled: false, startPeriod: "2026-08", maxRunsPerDay: 3 });
    await startObjectiveRun(run.id);
    expect(api.beta.agents.sessions.create).not.toHaveBeenCalled();
    expect((await prisma.contaBotObjectiveRun.findUniqueOrThrow({ where: { id: run.id } })).state).toBe("failed");
  });

  it("reassigns recurring work while paused and recreates a deleted chat only on explicit resume", async () => {
    await configureMandate(U, { companyId: A, responsibleUserId: U, enabled: true, startPeriod: "2026-08", maxRunsPerDay: 3 });
    await materializeMandate(A, new Date("2026-09-20T12:00:00Z"));
    await configureMandate(U, { companyId: A, responsibleUserId: U, enabled: false, startPeriod: "2026-08", maxRunsPerDay: 3 });
    await prisma.companyMember.updateMany({ where: { companyId: A, userId: V }, data: { role: "ACCOUNTANT" } });
    await configureMandate(U, { companyId: A, responsibleUserId: V, enabled: true, startPeriod: "2026-08", maxRunsPerDay: 3 });
    const objective = await prisma.contaBotObjective.findFirstOrThrow({ where: { companyId: A } });
    expect(objective).toMatchObject({ state: "paused", responsibleUserId: V });
    await prisma.chatConversation.delete({ where: { id: objective.conversationId! } });
    expect((await prisma.contaBotObjective.findUniqueOrThrow({ where: { id: objective.id } })).conversationId).toBeNull();
    await changeObjective(U, A, objective.id, "resume", objective.version);
    const resumed = await prisma.contaBotObjective.findUniqueOrThrow({ where: { id: objective.id } });
    expect(resumed.pausedAt).toBeNull(); expect(resumed.conversationId).toBeTruthy();
    expect(resumed.conversationId).not.toBe(objective.conversationId);
    const run = await queued(resumed.id);
    expect(run.userId).toBe(V);
  });
});
