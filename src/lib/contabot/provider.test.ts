import { describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import type { AgentSessionItem, TokenUsage } from "openai/resources/beta/agents/agents";
import { estimatedCostMicroUsd, textFromItems } from "./provider";
import { managedTools } from "./capabilities";

describe("Agents API boundary", () => {
  it("uses the SDK's beta header, function schema and event idempotency header", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init: init! });
      return String(url).endsWith("/events") ? new Response(null, { status: 202 })
        : Response.json({ id: "session_test", required_actions: [], status: "idle" });
    });
    const client = new OpenAI({ apiKey: "synthetic-key", fetch: fetcher });
    await client.beta.agents.sessions.create({ agent: { model: "gpt-6-astra", tools: managedTools(false) },
      environment: { type: "none" }, input: "Synthetic test" });
    await client.beta.agents.sessions.events.create("session_test", {
      "Idempotency-Key": "saved-request-id", events: [{ type: "agent.session.input.tool_result",
        turn_id: "turn_test", call_id: "call_test", success: true, output: "{}" }],
    });
    expect(requests[0].url).toBe("https://api.openai.com/v1/agents/sessions");
    expect(new Headers(requests[0].init.headers).get("OpenAI-Beta")).toBe("agents=v1");
    expect(new Headers(requests[1].init.headers).get("Idempotency-Key")).toBe("saved-request-id");
    const body = JSON.parse(String(requests[0].init.body));
    expect(body.environment).toEqual({ type: "none" });
    expect(body.agent.tools[0]).toMatchObject({ type: "function", parameters: { additionalProperties: false } });
  });

  it("never labels missing usage as free or double-counts reasoning", () => {
    expect(estimatedCostMicroUsd(null)).toBeNull();
    const usage: TokenUsage = { input_tokens: 100, output_tokens: 20, total_tokens: 120,
      input_tokens_details: { cached_tokens: 50 }, output_tokens_details: { reasoning_tokens: 10 } };
    expect(estimatedCostMicroUsd(usage)).toBe(4000);
  });

  it("keeps final output separate from other turns and progress commentary", () => {
    const item = (turn: string, phase: string, text: string) => ({ type: "message", role: "assistant",
      id: text, turn_id: turn, phase, status: "completed", content: [{ type: "output_text", text }] }) as AgentSessionItem;
    expect(textFromItems([item("old", "final_answer", "Old company period"), item("new", "commentary", "Checking"),
      item("new", "final_answer", "Missing bank statement")], "new")).toBe("Missing bank statement");
  });
});
