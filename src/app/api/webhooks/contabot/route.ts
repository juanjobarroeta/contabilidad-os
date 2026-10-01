import { NextResponse } from "next/server";
import { agentClient } from "@/lib/contabot/provider";
import { syncProviderSession } from "@/lib/contabot/runtime";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  if (!process.env.CONTABOT_OPENAI_WEBHOOK_SECRET || !process.env.OPENAI_API_KEY) return new Response(null, { status: 404 });
  const body = await req.text();
  if (Buffer.byteLength(body) > 100_000) return new Response(null, { status: 413 });
  try { await agentClient().webhooks.verifySignature(body, req.headers); }
  catch { return new Response("Invalid signature", { status: 400 }); }
  let event: { type?: string; data?: { id?: string } };
  try { event = JSON.parse(body); }
  catch { return new Response("Invalid event", { status: 400 }); }
  if (!["agent.session.created", "agent.session.action_required", "agent.session.in_progress",
    "agent.session.idle", "agent.session.failed"].includes(event.type ?? "") || typeof event.data?.id !== "string") {
    return new Response(null, { status: 204 });
  }
  try {
    // Retrieve canonical state. A delayed/repeated webhook is only a wake-up,
    // never evidence of success or permission to execute a payload's tool.
    await syncProviderSession(event.data.id);
    return NextResponse.json({ ok: true });
  } catch {
    console.error("[contabot] Webhook synchronization failed; retry required");
    return new Response("Retry later", { status: 503 });
  }
}
