import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/contabot/runtime", () => ({ syncProviderSession: vi.fn() }));
import { syncProviderSession } from "@/lib/contabot/runtime";
import { POST } from "./route";

const body = JSON.stringify({ type: "agent.session.action_required", data: { id: "session_test" } });
function request(payload = body, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", "synthetic-webhook-secret").update(`event_test.${timestamp}.${body}`).digest("base64");
  return new Request("https://test.local/api/webhooks/contabot", { method: "POST", body: payload,
    headers: { "webhook-id": "event_test", "webhook-timestamp": String(timestamp), "webhook-signature": `v1,${signature}` } });
}
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "synthetic-key");
  vi.stubEnv("CONTABOT_OPENAI_WEBHOOK_SECRET", "synthetic-webhook-secret");
  vi.mocked(syncProviderSession).mockReset();
});
afterEach(() => vi.unstubAllEnvs());
describe("ContaBot webhook", () => {
  it("accepts a signed wake-up and looks up canonical provider state", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(syncProviderSession).toHaveBeenCalledExactlyOnceWith("session_test");
  });
  it("rejects forged, expired and unsigned events without executing work", async () => {
    expect((await POST(request(body.replace("session_test", "session_other")))).status).toBe(400);
    expect((await POST(request(body, Math.floor(Date.now() / 1000) - 600))).status).toBe(400);
    expect((await POST(new Request("https://test.local", { method: "POST", body }))).status).toBe(400);
    expect(syncProviderSession).not.toHaveBeenCalled();
  });
  it("asks for a retry on an interrupted database/provider operation", async () => {
    vi.mocked(syncProviderSession).mockRejectedValueOnce(new Error("Synthetic outage"));
    expect((await POST(request())).status).toBe(503);
  });
});
