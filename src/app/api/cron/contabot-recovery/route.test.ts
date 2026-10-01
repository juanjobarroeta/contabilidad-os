import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), sync: vi.fn(), lock: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { contaBotSession: { findMany: mocks.findMany } } }));
vi.mock("@/lib/contabot/runtime", () => ({ syncManagedSession: mocks.sync }));
vi.mock("@/lib/cron-lock", () => ({ withCronLock: mocks.lock }));
import { POST } from "./route";

describe("ContaBot recovery scheduler authentication", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "synthetic-cron-secret");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-key");
    vi.stubEnv("CONTABOT_OPENAI_WEBHOOK_SECRET", "synthetic-webhook-secret");
    mocks.findMany.mockResolvedValue([{ id: "synthetic-run" }]);
    mocks.sync.mockResolvedValue(true);
    mocks.lock.mockImplementation(async (_name, run) => run());
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it.each<Record<string, string>>([
    { "x-cron-secret": "synthetic-cron-secret" },
    { authorization: "Bearer synthetic-cron-secret" },
  ])("processes pending work with an established cron header %j", async (headers) => {
    const response = await POST(new Request("http://localhost/api/cron/contabot-recovery", { method: "POST", headers }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ processed: 1, pending: 1 });
    expect(mocks.sync).toHaveBeenCalledWith("synthetic-run");
    expect(mocks.lock).toHaveBeenCalledWith("contabot-recovery", expect.any(Function));
  });

  it.each<Record<string, string>>([{}, { "x-cron-secret": "wrong" }, { authorization: "Bearer wrong" }])(
    "rejects unauthenticated recovery before reading pending work %j", async (headers) => {
      const response = await POST(new Request("http://localhost/api/cron/contabot-recovery", { method: "POST", headers }));
      expect(response.status).toBe(401);
      expect(mocks.findMany).not.toHaveBeenCalled();
      expect(mocks.sync).not.toHaveBeenCalled();
    },
  );
});
