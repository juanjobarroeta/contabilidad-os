import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { loadAccessibleConversation } from "@/lib/ai/conversation-access";
import { sanearRef, sanearTarjetas } from "@/lib/copiloto/tarjetas";
import { deleteManagedSessions } from "@/lib/contabot/runtime";
import { ContaBotError } from "@/lib/contabot/config";
import { requireContaBotAccess } from "@/lib/contabot/access";
import { getChatPendingAction } from "@/lib/ai/pending-action";

type Params = { params: Promise<{ id: string }> };

// GET /api/ai/conversations/[id] — encabezado + mensajes de la conversación.
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { conv, isOwner, canView } = await loadAccessibleConversation(id, session.user.id);
  if (!conv) return NextResponse.json({ error: "No encontrada" }, { status: 404 });
  if (!canView) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });
  if (await prisma.contaBotSession.count({ where: { conversationId: id } })) {
    try { await requireContaBotAccess(session.user.id, conv.companyId, id, { requireEnabled: false }); }
    catch (error) {
      if (error instanceof ContaBotError) return NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }

  const messages = await prisma.chatMessage.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, content: true, createdAt: true, feedback: true, cards: true, meta: true },
  });
  const activeRun = await prisma.contaBotSession.findFirst({
    where: { conversationId: id, userId: session.user.id, state: { notIn: ["idle", "usage_pending", "deleting"] } },
    select: { id: true, requestId: true },
  });
  const pending = await getChatPendingAction(id);

  return NextResponse.json({
    id: conv.id,
    title: conv.title,
    visibility: conv.visibility,
    mine: isOwner,
    activeManagedRun: activeRun,
    // Completed background work still needs its confirmation card when the
    // conversation is reopened. The executor's payload stays on the server.
    pendingAction: pending ? { type: pending.type, summary: pending.summary, token: pending.token, expiresAt: pending.expiresAt } : null,
    // La traza (meta) no sale: sólo la referencia que el usuario adjuntó.
    messages: messages.map(({ meta, cards, ...m }) => {
      const ref = m.role === "user" ? sanearRef((meta as { ref?: unknown } | null)?.ref) : null;
      const tarjetas = m.role === "assistant" ? sanearTarjetas(cards) : [];
      return { ...m, ...(ref ? { ref } : {}), ...(tarjetas.length ? { cards: tarjetas } : {}) };
    }),
  });
}

// PATCH /api/ai/conversations/[id] — renombrar / cambiar visibilidad / archivar.
// Sólo el dueño.
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { conv, isOwner } = await loadAccessibleConversation(id, session.user.id);
  if (!conv) return NextResponse.json({ error: "No encontrada" }, { status: 404 });
  if (!isOwner) return NextResponse.json({ error: "Sólo el dueño puede modificarla" }, { status: 403 });

  const body = await req.json();
  const { title, visibility, archivar } = body as {
    title?: string;
    visibility?: "PRIVATE" | "COMPANY";
    archivar?: boolean;
  };

  const updated = await prisma.chatConversation.update({
    where: { id },
    data: {
      ...(typeof title === "string" && title.trim() ? { title: title.trim().slice(0, 80) } : {}),
      ...(visibility === "PRIVATE" || visibility === "COMPANY" ? { visibility } : {}),
      ...(archivar ? { archivedAt: new Date() } : {}),
    },
    select: { id: true, title: true, visibility: true },
  });
  return NextResponse.json(updated);
}

// DELETE /api/ai/conversations/[id] — borra la conversación (y sus mensajes en
// cascada). Sólo el dueño.
export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { conv, isOwner } = await loadAccessibleConversation(id, session.user.id);
  if (!conv) return NextResponse.json({ error: "No encontrada" }, { status: 404 });
  if (!isOwner) return NextResponse.json({ error: "Sólo el dueño puede borrarla" }, { status: 403 });

  try { await deleteManagedSessions(id); }
  catch (error) {
    return NextResponse.json({ error: error instanceof ContaBotError ? error.message : "No se pudo borrar la sesión del agente. Inténtalo de nuevo." },
      { status: error instanceof ContaBotError ? error.status : 503 });
  }
  await prisma.chatConversation.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
