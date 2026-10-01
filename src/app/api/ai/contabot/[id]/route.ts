import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireContaBotAccess } from "@/lib/contabot/access";
import { ContaBotError } from "@/lib/contabot/config";
import { getChatPendingAction } from "@/lib/ai/pending-action";
import { sanearTarjetas } from "@/lib/copiloto/tarjetas";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await auth();
  if (!user?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const run = await prisma.contaBotSession.findUnique({ where: { id } });
  if (!run || run.userId !== user.user.id) return NextResponse.json({ error: "No encontrada" }, { status: 404 });
  try { await requireContaBotAccess(user.user.id, run.companyId, run.conversationId, { requireEnabled: false }); }
  catch (error) {
    if (error instanceof ContaBotError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
  if (new URL(req.url).searchParams.get("requestId") !== run.requestId) {
    return NextResponse.json({ error: "La conversación tiene una tarea más reciente. Vuelve a abrirla." }, { status: 409 });
  }
  const [message, lastCall, pending] = await Promise.all([
    run.assistantMessageId ? prisma.chatMessage.findUnique({ where: { id: run.assistantMessageId } }) : null,
    run.providerTurnId ? prisma.contaBotToolCall.findFirst({
      where: { sessionId: id, turnId: run.providerTurnId }, orderBy: { createdAt: "desc" }, select: { name: true, state: true },
    }) : null,
    getChatPendingAction(run.conversationId),
  ]);
  return NextResponse.json({
    done: ["idle", "usage_pending"].includes(run.state),
    state: run.state,
    activeTool: lastCall?.state === "running" ? lastCall.name : null,
    message: message ? { id: message.id, role: "assistant", content: message.content || run.error || "",
      cards: sanearTarjetas(message.cards) } : null,
    pendingAction: pending ? { type: pending.type, summary: pending.summary, token: pending.token, expiresAt: pending.expiresAt } : null,
  }, { headers: { "Cache-Control": "private, no-store" } });
}
