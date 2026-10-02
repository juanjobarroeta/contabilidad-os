import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { documentFingerprint } from "@/lib/fiscal/document-fingerprint";

/** Persist BEFORE tools run, including on the legacy streamed path. A retry
 * with the same request ID must reference the same human request. */
export async function persistChatUserTurn(input: { conversationId: string; userId: string; requestId: string; content: string; meta?: Prisma.InputJsonObject }) {
  const id = documentFingerprint(["chat-user-turn-v1", input.conversationId, input.userId, input.requestId]);
  const row = await prisma.chatMessage.upsert({ where: { id }, create: { id, conversationId: input.conversationId, authorId: input.userId, role: "user", content: input.content, meta: { ...input.meta, requestId: input.requestId } }, update: {} });
  if (row.content !== input.content) throw new Error("Esta solicitud ya existe con otro contenido. Envía un mensaje nuevo.");
  return row.id;
}
