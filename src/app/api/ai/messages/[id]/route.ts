import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { loadAccessibleConversation } from "@/lib/ai/conversation-access";

type Params = { params: Promise<{ id: string }> };

// PATCH /api/ai/messages/[id] — feedback del contador sobre UNA respuesta del
// asistente: { feedback: "up" | "down" | null, correccion?: string }.
//
// Es la materia prima del eval del copiloto: cada pulgar abajo con corrección
// es una pregunta real con la respuesta que un contador esperaba. Sin esto
// «el copiloto se equivocó» se queda en una queja de pasillo.
//
// Quien puede VER la conversación puede opinar (en las compartidas, todo el
// equipo). Sólo mensajes del asistente.
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const msg = await prisma.chatMessage.findUnique({
    where: { id },
    select: { id: true, role: true, conversationId: true },
  });
  if (!msg) return NextResponse.json({ error: "Mensaje no encontrado" }, { status: 404 });
  if (msg.role !== "assistant") {
    return NextResponse.json({ error: "Sólo se califican respuestas del asistente" }, { status: 400 });
  }

  const { conv, canView } = await loadAccessibleConversation(msg.conversationId, session.user.id);
  if (!conv || !canView) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { feedback?: unknown; correccion?: unknown } | null;
  const feedback = body?.feedback;
  if (feedback !== "up" && feedback !== "down" && feedback !== null) {
    return NextResponse.json({ error: "feedback debe ser 'up', 'down' o null" }, { status: 400 });
  }
  const correccion =
    typeof body?.correccion === "string" ? body.correccion.trim().slice(0, 4000) || null : undefined;

  const updated = await prisma.chatMessage.update({
    where: { id },
    data: {
      feedback,
      ...(correccion !== undefined ? { correccion } : {}),
      feedbackAt: feedback ? new Date() : null,
    },
    select: { id: true, feedback: true, correccion: true },
  });
  return NextResponse.json(updated);
}
