import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "pilot-user" } }) }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  contaBotSession: { count: async () => 1, findFirst: async () => null },
  chatMessage: { findMany: async () => [{ id: "answer", role: "assistant", content: "Match proposed.", cards: [], meta: {} }] },
} }));
vi.mock("@/lib/ai/conversation-access", () => ({ loadAccessibleConversation: async () => ({
  conv: { id: "conversation", companyId: "pilot", title: "September close", visibility: "PRIVATE" }, isOwner: true, canView: true,
}) }));
vi.mock("@/lib/contabot/access", () => ({ requireContaBotAccess: async () => ({ canWrite: true }) }));
vi.mock("@/lib/contabot/runtime", () => ({ deleteManagedSessions: vi.fn() }));
vi.mock("@/lib/ai/pending-action", () => ({ getChatPendingActions: async () => [{
  type: "conciliar", summary: "Match invoice and bank movement", token: "confirmation-token", expiresAt: 2000000000000,
  companyId: "pilot", payload: { txId: "movement", invoiceId: "invoice" },
}] }));
import { GET } from "./route";

describe("reopening completed background work", () => {
  it("restores the confirmation card even when there is no active agent run", async () => {
    const response = await GET(new Request("https://test.local/api/ai/conversations/conversation"), { params: Promise.resolve({ id: "conversation" }) });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.activeManagedRun).toBeNull();
    expect(body.pendingAction).toEqual({ type: "conciliar", summary: "Match invoice and bank movement",
      token: "confirmation-token", expiresAt: 2000000000000 });
    expect(body.messages[0].content).toBe("Match proposed.");
  });
});
