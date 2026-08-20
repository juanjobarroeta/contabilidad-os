import { prisma } from "@/lib/prisma";
import { createIssueForAsk, githubReady, mrrNoteForAsk } from "./github";
import { updateAskCard, tgApi, type AskAction, type AskConRelaciones } from "./telegram";

// ─────────────────────────────────────────────────────────────────────────────
// Resolución de un ask desde la tarjeta de Telegram. Cada acción edita la
// tarjeta en su lugar para que el chat quede como bitácora de auditoría.
// ─────────────────────────────────────────────────────────────────────────────

async function loadAsk(askId: string): Promise<AskConRelaciones | null> {
  return prisma.candidateAsk.findUnique({
    where: { id: askId },
    include: { contact: true, transcript: true, dedupeOf: true },
  });
}

export async function handleAskAction(askId: string, action: AskAction): Promise<string> {
  const ask = await loadAsk(askId);
  if (!ask) return "Ese ask ya no existe.";
  if (ask.status !== "PENDING" && action !== "edit") {
    return `Ya estaba resuelto (${ask.status}).`;
  }

  switch (action) {
    case "approve": {
      if (!githubReady(ask.product)) {
        return "GitHub no está configurado (INTAKE_GITHUB_TOKEN / INTAKE_GITHUB_REPO).";
      }
      const mrrNote = await mrrNoteForAsk(ask);
      const issue = await createIssueForAsk(ask, { mrrNote });
      const updated = await prisma.candidateAsk.update({
        where: { id: ask.id },
        data: {
          status: "APPROVED",
          reviewedAt: new Date(),
          githubIssueUrl: issue.url,
          githubNodeId: issue.nodeId,
        },
        include: { contact: true, transcript: true, dedupeOf: true },
      });
      await updateAskCard(updated, `✅ Issue creado: ${issue.url}\n`);
      return "Issue creado.";
    }
    case "merge": {
      if (!ask.dedupeOfId) return "Este ask no tiene duplicado marcado.";
      const updated = await prisma.candidateAsk.update({
        where: { id: ask.id },
        data: { status: "MERGED", reviewedAt: new Date() },
        include: { contact: true, transcript: true, dedupeOf: true },
      });
      const destino = updated.dedupeOf?.githubIssueUrl ?? `"${updated.dedupeOf?.title ?? "?"}"`;
      await updateAskCard(updated, `🔀 Fusionado con ${destino}\n`);
      return "Fusionado.";
    }
    case "discard": {
      const updated = await prisma.candidateAsk.update({
        where: { id: ask.id },
        data: { status: "REJECTED", reviewedAt: new Date() },
        include: { contact: true, transcript: true, dedupeOf: true },
      });
      await updateAskCard(updated, "❌ Descartado\n");
      return "Descartado.";
    }
    case "edit": {
      // force_reply: la respuesta del usuario (con el marcador #ask:<id>)
      // llega como mensaje normal al webhook y ahí se aplica el nuevo título.
      await tgApi("sendMessage", {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: `✏️ Responde a ESTE mensaje con el nuevo título. #ask:${ask.id}`,
        reply_markup: { force_reply: true },
      });
      return "Espero el nuevo título como respuesta.";
    }
  }
}

/** Aplica el título editado que llegó como respuesta al force_reply. */
export async function applyEditedTitle(askId: string, nuevoTitulo: string): Promise<string> {
  const titulo = nuevoTitulo.trim().slice(0, 200);
  if (!titulo) return "Título vacío; no cambié nada.";
  const updated = await prisma.candidateAsk.update({
    where: { id: askId },
    data: { title: titulo },
    include: { contact: true, transcript: true, dedupeOf: true },
  });
  // Re-render de la tarjeta original con el título nuevo (sigue PENDING, con
  // sus botones intactos gracias a editMessageText sin reply_markup… que los
  // borra — así que lo reponemos).
  if (updated.telegramMessageId) {
    const { renderAskCard, askKeyboard } = await import("./telegram");
    await tgApi("editMessageText", {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      message_id: Number(updated.telegramMessageId),
      text: renderAskCard(updated),
      parse_mode: "Markdown",
      reply_markup: askKeyboard(updated),
    });
  }
  return `Título actualizado: ${titulo}`;
}
