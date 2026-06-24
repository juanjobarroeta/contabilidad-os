import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { loadAccessibleConversation } from "@/lib/ai/conversation-access";

type Params = { params: Promise<{ id: string }> };

// GET /api/ai/conversations/[id] — encabezado + mensajes de la conversación.
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { conv, isOwner, canView } = await loadAccessibleConversation(id, session.user.id);
  if (!conv) return NextResponse.json({ error: "No encontrada" }, { status: 404 });
  if (!canView) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const messages = await prisma.chatMessage.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: "asc" },
    select: { role: true, content: true, createdAt: true },
  });

  return NextResponse.json({
    id: conv.id,
    title: conv.title,
    visibility: conv.visibility,
    mine: isOwner,
    messages,
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

  await prisma.chatConversation.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
