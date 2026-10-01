import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionItem } from "openai/resources/beta/agents/agents";
vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/ai/guardia", () => ({
  estadoIAEmpresa: async () => ({ gastoMesUsd: 0, topeMesUsd: 100 }),
  asegurarUsoIA: async () => ({ ok: true }),
}));
vi.mock("@/lib/subscription", () => ({ gateEscritura: async () => null }));
vi.mock("./provider", async (original) => ({ ...await original<object>(), agentClient: vi.fn() }));
import { prisma } from "@/lib/prisma";
import { agentClient } from "./provider";
import { requireContaBotAccess } from "./access";
import { MAX_TOOL_CALLS } from "./config";
import { beginManagedTurn, executeManagedCall, syncManagedSession, deleteManagedSessions } from "./runtime";

const A = "itest-contabot-a", B = "itest-contabot-b", U = "itest-contabot-owner", V = "itest-contabot-viewer";
const skip = process.env.DB_TESTS_SKIP === "1";
let sequence = 0;
let remote: AgentSession;
let turns: { id: string; subagent_id: null; status: string; usage: AgentSession["usage"] }[];
let items: AgentSessionItem[];
let api: ReturnType<typeof agentClient>;
const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120,
  input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };

async function newRun(userId = U, companyId = A) {
  const conv = await prisma.chatConversation.create({ data: { companyId, userId, title: "Synthetic ContaBot test" } });
  return beginManagedTurn({ conversationId: conv.id, companyId, userId, requestId: randomUUID(),
    text: "Check the month", instructions: "Synthetic context" });
}
function action(name: string, args: Record<string, unknown>, callId = "call_test") {
  return { type: "function_call" as const, name, arguments: args, turn_id: "turn_new", call_id: callId };
}

async function cleanup() {
  await prisma.costEvent.deleteMany({ where: { companyId: { in: [A, B] } } });
  await prisma.company.deleteMany({ where: { id: { in: [A, B] } } });
  await prisma.user.deleteMany({ where: { id: { in: [U, V] } } });
}

describe.skipIf(skip)("managed ContaBot with real Postgres and synthetic provider", () => {
  beforeAll(async () => {
    await cleanup();
    vi.stubEnv("CONTABOT_MANAGED_ENABLED", "1");
    vi.stubEnv("CONTABOT_MANAGED_COMPANY_IDS", `${A},${B}`);
    vi.stubEnv("OPENAI_API_KEY", "synthetic-key");
    vi.stubEnv("CONTABOT_OPENAI_WEBHOOK_SECRET", "synthetic-secret");
    await prisma.user.createMany({ data: [{ id: U, email: "contabot-owner@test.local", esOperador: true },
      { id: V, email: "contabot-viewer@test.local" }] });
    await prisma.company.createMany({ data: [A, B].map((id) => ({ id, rfc: id, razonSocial: id,
      regimenFiscal: "601", codigoPostal: "06600" })) });
    await prisma.companyMember.createMany({ data: [
      { companyId: A, userId: U, role: "OWNER" }, { companyId: A, userId: V, role: "VIEWER" },
    ] });
  });
  afterAll(async () => { await cleanup(); vi.unstubAllEnvs(); });
  beforeEach(async () => {
    await prisma.chatConversation.deleteMany({ where: { companyId: { in: [A, B] } } });
    await prisma.expedienteNota.deleteMany({ where: { companyId: { in: [A, B] } } });
    await prisma.companyMember.updateMany({ where: { companyId: A, userId: U }, data: { role: "OWNER", allowedModules: [] } });
    items = [];
    turns = [{ id: "turn_new", subagent_id: null, status: "waiting", usage }];
    remote = { id: `session_synthetic_${++sequence}`, metadata: {}, required_actions: [], status: "requires_action" } as unknown as AgentSession;
    const sessions = {
      create: vi.fn(async (body) => { remote.metadata = body.metadata; return remote; }),
      retrieve: vi.fn(async () => remote),
      delete: vi.fn(async () => ({})),
      list: vi.fn(async function* () { yield remote; }),
      turns: { list: vi.fn(async () => ({ data: turns })), retrieve: vi.fn(async () => turns[0]) },
      items: { list: vi.fn(async function* () { for (const item of [...items].reverse()) yield item; }) },
      events: { create: vi.fn(async () => undefined) },
    };
    api = { beta: { agents: { sessions } } } as unknown as ReturnType<typeof agentClient>;
    vi.mocked(agentClient).mockReturnValue(api);
  });

  it("does not turn platform operator status or a foreign conversation into company access", async () => {
    await expect(requireContaBotAccess(U, B)).rejects.toMatchObject({ status: 403 });
    const foreign = await prisma.chatConversation.create({ data: { companyId: B, userId: U } });
    await expect(requireContaBotAccess(U, A, foreign.id)).rejects.toMatchObject({ status: 403 });
    await prisma.companyMember.update({ where: { userId_companyId: { userId: U, companyId: A } }, data: { allowedModules: ["CONSTRUCCION"] } });
    await expect(requireContaBotAccess(U, A)).rejects.toMatchObject({ status: 403 });
  });

  it("claims the company atomically so two browser tabs cannot start concurrent paid work", async () => {
    const results = await Promise.allSettled([newRun(), newRun()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(api.beta.agents.sessions.create).not.toHaveBeenCalled();
    expect(await prisma.chatMessage.count({ where: { role: "user", conversation: { companyId: A } } })).toBe(1);
  });

  it("persists one memory note and reuses the saved result after a repeated callback", async () => {
    const session = await newRun();
    const call = action("anotar_expediente", { tipo: "pendiente", tema: "conciliacion", titulo: "Missing statement",
      cuerpo: "Synthetic bank statement for September is missing." });
    const first = await executeManagedCall(session, call);
    const second = await executeManagedCall(session, call);
    expect(first.id).toBe(second.id);
    expect(second.result).toBe(first.result);
    expect(await prisma.expedienteNota.count({ where: { companyId: A } })).toBe(1);
    expect(await prisma.expedienteNota.count({ where: { companyId: B } })).toBe(0);
    expect(first.card).toMatchObject({ type: "memoria" });
  });

  it("revalidates a downgraded user's role and rejects model-selected tenant IDs", async () => {
    const session = await newRun();
    await prisma.companyMember.update({ where: { userId_companyId: { userId: U, companyId: A } }, data: { role: "VIEWER" } });
    const result = await executeManagedCall(session, action("anotar_expediente", {
      tipo: "pendiente", tema: "general", titulo: "Not allowed", cuerpo: "Not allowed",
    }));
    expect(result).toMatchObject({ success: false, result: "TOOL_NOT_AUTHORIZED" });
    expect(await prisma.expedienteNota.count({ where: { companyId: A } })).toBe(0);
    const other = await executeManagedCall(session, action("query_invoices", { companyId: B }, "call_other"));
    expect(other).toMatchObject({ success: false, result: "INVALID_ARGUMENTS" });
  });

  it("halts an uncertain write instead of attempting it twice after a worker crash", async () => {
    const session = await newRun();
    await prisma.contaBotToolCall.create({ data: { sessionId: session.id, turnId: "turn_new", callId: "call_test",
      name: "anotar_expediente", arguments: {}, state: "running" } });
    await expect(executeManagedCall(session, action("anotar_expediente", {}))).rejects.toMatchObject({ status: 409 });
    expect(await prisma.expedienteNota.count({ where: { companyId: A } })).toBe(0);
  });

  it("stages a bank match for confirmation and rejects a foreign invoice without posting", async () => {
    const session = await newRun();
    const bank = await prisma.bankAccount.create({ data: { companyId: A, banco: "Synthetic", nombre: "Synthetic bank",
      numeroCuenta: randomUUID() } });
    const movement = await prisma.bankTransaction.create({ data: { companyId: A, bankAccountId: bank.id,
      fecha: new Date(), descripcion: "Synthetic deposit", monto: 116, tipo: "CREDITO" } });
    const invoiceData = { tipo: "INGRESO" as const, fecha: new Date(), formaPago: "03", metodoPago: "PUE",
      usoCfdi: "G03", subtotal: 100, total: 116 };
    const invoice = await prisma.invoice.create({ data: { ...invoiceData, companyId: A } });
    const foreign = await prisma.invoice.create({ data: { ...invoiceData, companyId: B } });
    const invalid = await executeManagedCall(session, action("proponer_conciliacion", {
      transaction_id: movement.id, invoice_id: foreign.id,
    }, "call_foreign_invoice"));
    expect(JSON.parse(invalid.result!)).toHaveProperty("error");
    expect((await prisma.chatConversation.findUniqueOrThrow({ where: { id: session.conversationId } })).pendingAction).toBeNull();
    await executeManagedCall(session, action("proponer_conciliacion", {
      transaction_id: movement.id, invoice_id: invoice.id,
    }, "call_own_invoice"));
    const conversation = await prisma.chatConversation.findUniqueOrThrow({ where: { id: session.conversationId } });
    expect(conversation.pendingAction).toMatchObject({ type: "conciliar", companyId: A,
      payload: { txId: movement.id, invoiceId: invoice.id } });
    expect((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: movement.id } })).invoiceId).toBeNull();
  });

  it("runs through a tool call, saves the answer and meters a completed turn exactly once", async () => {
    const session = await newRun();
    remote.required_actions = [action("consultar_expediente", {})];
    await syncManagedSession(session.id);
    expect(api.beta.agents.sessions.create).toHaveBeenCalledOnce();
    expect(api.beta.agents.sessions.events.create).toHaveBeenCalledWith(remote.id, expect.objectContaining({
      events: [expect.objectContaining({ type: "agent.session.input.tool_result", success: true })],
    }));
    remote.required_actions = [];
    remote.status = "idle";
    turns[0].status = "completed";
    items = [{ id: "answer", type: "message", role: "assistant", status: "completed", phase: "final_answer",
      turn_id: "turn_new", content: [{ type: "output_text", text: "Need the missing statement." }] }];
    await syncManagedSession(session.id);
    await syncManagedSession(session.id);
    const saved = await prisma.contaBotSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(saved.state).toBe("idle");
    expect(saved.activeCompanyId).toBeNull();
    expect((await prisma.chatMessage.findUniqueOrThrow({ where: { id: saved.assistantMessageId! } })).content).toBe("Need the missing statement.");
    expect(await prisma.costEvent.count({ where: { id: `contabot:${session.id}:turn_new` } })).toBe(1);
  });

  it("exposes stored RFC, currency and payment evidence without requiring a Customer record", async () => {
    const session = await newRun();
    const bank = await prisma.bankAccount.create({ data: { companyId: A, banco: "Synthetic",
      nombre: "USD test", numeroCuenta: randomUUID(), moneda: "USD" } });
    const movement = await prisma.bankTransaction.create({ data: { companyId: A, bankAccountId: bank.id,
      fecha: new Date(), descripcion: "Synthetic transfer", monto: 116, tipo: "CREDITO",
      contraparteRfc: "AAA010101AAA", contraparteNombre: "Synthetic customer", conceptoPago: "TEST-101" } });
    const invoiceData = { tipo: "INGRESO" as const, fecha: new Date(), formaPago: "03", metodoPago: "PPD",
      usoCfdi: "G03", subtotal: 100, total: 116, status: "STAMPED" as const, moneda: "USD",
      folio: "TEST-101", contraparteRfc: "AAA010101AAA", contraparteNombre: "Synthetic customer" };
    const invoice = await prisma.invoice.create({ data: { ...invoiceData, companyId: A } });
    const foreign = await prisma.invoice.create({ data: { ...invoiceData, companyId: B } });
    const read = async (name: string, args: Record<string, unknown>) => {
      const receipt = await executeManagedCall(session, action(name, args, name));
      expect(receipt.success).toBe(true);
      return JSON.parse(receipt.result!);
    };
    const evidence = { id: movement.id, moneda: "USD", contraparteRfc: "AAA010101AAA",
      contraparteNombre: "Synthetic customer" };
    const bankResult = await read("query_bank_transactions", { bank_account_id: bank.id });
    expect(bankResult.movimientos).toEqual([expect.objectContaining({ ...evidence, conceptoPago: "TEST-101" })]);
    const invoices = await read("query_invoices", { q: "TEST-101" });
    expect(invoices.facturas).toEqual([expect.objectContaining({ id: invoice.id, folio: "TEST-101",
      moneda: "USD", metodoPago: "PPD", contraparteRfc: "AAA010101AAA" })]);
    const suggestion = await read("suggest_reconciliation_match", { transaction_id: movement.id });
    expect(suggestion.transaction).toMatchObject(evidence);
    expect(suggestion.candidate_invoices).toContainEqual(expect.objectContaining({ id: invoice.id,
      moneda: "USD", metodoPago: "PPD", clienteRfc: "AAA010101AAA", cliente: "Synthetic customer" }));
    expect(suggestion.candidate_invoices.some((inv: { id: string }) => inv.id === foreign.id)).toBe(false);
    const unmatched = await read("list_unmatched_transactions", {});
    expect(unmatched.transactions).toContainEqual(expect.objectContaining(evidence));
    expect((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: movement.id } })).invoiceId).toBeNull();
  });

  it("enforces the tool budget while allowing a completed callback to be replayed", async () => {
    const session = await newRun();
    await prisma.contaBotToolCall.createMany({ data: Array.from({ length: MAX_TOOL_CALLS }, (_, i) => ({
      sessionId: session.id, turnId: "turn_new", callId: `budget_${i}`, name: "consultar_expediente",
      arguments: {}, state: "done", success: true, result: "{}",
    })) });
    await expect(executeManagedCall(session, action("consultar_expediente", {}, "budget_0")))
      .resolves.toMatchObject({ success: true, result: "{}" });
    await expect(executeManagedCall(session, action("consultar_expediente", {}, "beyond_budget")))
      .rejects.toMatchObject({ status: 429 });
    expect(await prisma.contaBotToolCall.count({ where: { sessionId: session.id } })).toBe(MAX_TOOL_CALLS);
  });

  it("does not mistake idle or an older turn for completion of new work", async () => {
    const session = await newRun();
    await syncManagedSession(session.id);
    await prisma.contaBotSession.update({ where: { id: session.id }, data: { providerTurnId: null, previousTurnId: "turn_new" } });
    remote.status = "idle";
    turns = [{ id: "turn_new", subagent_id: null, status: "completed", usage },
      { id: "turn_older", subagent_id: null, status: "completed", usage }];
    await syncManagedSession(session.id);
    expect((await prisma.contaBotSession.findUniqueOrThrow({ where: { id: session.id } })).state).toBe("working");
  });

  it("keeps the company budget reservation when terminal usage is unknown", async () => {
    const session = await newRun();
    turns[0] = { ...turns[0], status: "completed", usage: null };
    await syncManagedSession(session.id);
    const saved = await prisma.contaBotSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(saved).toMatchObject({ state: "usage_pending", activeCompanyId: A });
    await expect(newRun(V)).rejects.toMatchObject({ status: 409 });
  });

  it("recovers an ambiguous creation by metadata without creating a second agent", async () => {
    const session = await newRun();
    remote.metadata = { contabot_session: session.id };
    vi.mocked(api.beta.agents.sessions.create).mockRejectedValueOnce(new Error("Synthetic lost response after provider accepted"));
    await expect(syncManagedSession(session.id)).rejects.toMatchObject({ status: 503 });
    expect((await prisma.contaBotSession.findUniqueOrThrow({ where: { id: session.id } })).state).toBe("uncertain");
    await syncManagedSession(session.id);
    expect(api.beta.agents.sessions.create).toHaveBeenCalledOnce();
    expect((await prisma.contaBotSession.findUniqueOrThrow({ where: { id: session.id } })).providerSessionId).toBe(remote.id);
  });

  it("reuses the provider session and idempotency key for a follow-up after a lost submission response", async () => {
    const session = await newRun();
    turns[0].status = "completed";
    await syncManagedSession(session.id);
    const next = await beginManagedTurn({ conversationId: session.conversationId, companyId: A, userId: U,
      requestId: randomUUID(), text: "Continue the investigation", instructions: "Synthetic context" });
    turns = [{ id: "turn_followup", subagent_id: null, status: "waiting", usage }];
    vi.mocked(api.beta.agents.sessions.events.create).mockRejectedValueOnce(new Error("Synthetic timeout"));
    await expect(syncManagedSession(next.id)).rejects.toThrow("Synthetic timeout");
    await syncManagedSession(next.id);
    expect(api.beta.agents.sessions.create).toHaveBeenCalledOnce();
    const submissions = vi.mocked(api.beta.agents.sessions.events.create).mock.calls;
    expect(submissions[0][1]["Idempotency-Key"]).toBe(submissions[1][1]["Idempotency-Key"]);
    expect((await prisma.contaBotSession.findUniqueOrThrow({ where: { id: next.id } })).providerTurnId).toBe("turn_followup");
  });

  it("cancels provider work when company access is revoked", async () => {
    const session = await newRun();
    await syncManagedSession(session.id);
    await prisma.companyMember.update({ where: { userId_companyId: { userId: U, companyId: A } }, data: { allowedModules: ["CONSTRUCCION"] } });
    remote.required_actions = [action("consultar_expediente", {})];
    await syncManagedSession(session.id);
    expect(api.beta.agents.sessions.events.create).toHaveBeenCalledWith(remote.id, expect.objectContaining({
      events: [{ type: "agent.session.input.cancel" }],
    }));
    expect(await prisma.contaBotToolCall.count({ where: { sessionId: session.id } })).toBe(0);
  });

  it("deletes provider history before local conversation data can be removed", async () => {
    const session = await newRun();
    await syncManagedSession(session.id);
    await deleteManagedSessions(session.conversationId);
    expect(api.beta.agents.sessions.delete).toHaveBeenCalledWith(remote.id);
    expect((await prisma.contaBotSession.findUniqueOrThrow({ where: { id: session.id } })).state).toBe("deleting");
  });
});
