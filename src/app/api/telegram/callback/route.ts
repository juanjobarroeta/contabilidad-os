import { NextResponse } from "next/server";
import { telegramConfigured } from "@/lib/intake/config";
import { parseCallback, parseEditMarker, tgApi } from "@/lib/intake/telegram";
import { handleAskAction, applyEditedTitle } from "@/lib/intake/approve";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/telegram/callback — webhook del bot de aprobación de intake.
//
// Auth: header X-Telegram-Bot-Api-Secret-Token (se fija con setWebhook
// secret_token=TELEGRAM_WEBHOOK_SECRET) + el chat debe ser TELEGRAM_CHAT_ID.
// Maneja dos cosas: callbacks de los botones inline (ask:<id>:<action>) y las
// respuestas al force_reply de "✏️ Editar" (marcador #ask:<id>).
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TgUpdate = {
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat?: { id?: number } };
  };
  message?: {
    text?: string;
    chat?: { id?: number };
    reply_to_message?: { text?: string };
  };
};

function chatAutorizado(chatId: number | undefined): boolean {
  return chatId != null && String(chatId) === process.env.TELEGRAM_CHAT_ID;
}

export async function POST(req: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!telegramConfigured() || !secret) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const update = (await req.json().catch(() => null)) as TgUpdate | null;
  if (!update) return NextResponse.json({ ok: true });

  // ── Botones inline ─────────────────────────────────────────────────────────
  const cb = update.callback_query;
  if (cb) {
    if (!chatAutorizado(cb.message?.chat?.id)) return NextResponse.json({ ok: true });
    const parsed = parseCallback(cb.data);
    let texto = "No entendí la acción.";
    if (parsed) {
      try {
        texto = await handleAskAction(parsed.askId, parsed.action);
      } catch (e) {
        texto = `Error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 190);
        console.error("[intake] handleAskAction failed", parsed, e);
      }
    }
    // Siempre contestar el callback para que el spinner del botón se apague.
    try {
      await tgApi("answerCallbackQuery", { callback_query_id: cb.id, text: texto.slice(0, 190) });
    } catch (e) {
      console.error("[intake] answerCallbackQuery failed", e);
    }
    return NextResponse.json({ ok: true });
  }

  // ── Respuesta al force_reply de "✏️ Editar" ────────────────────────────────
  const msg = update.message;
  if (msg?.reply_to_message?.text && msg.text) {
    if (!chatAutorizado(msg.chat?.id)) return NextResponse.json({ ok: true });
    const askId = parseEditMarker(msg.reply_to_message.text);
    if (askId) {
      try {
        const resultado = await applyEditedTitle(askId, msg.text);
        await tgApi("sendMessage", { chat_id: process.env.TELEGRAM_CHAT_ID, text: resultado });
      } catch (e) {
        console.error("[intake] applyEditedTitle failed", askId, e);
      }
    }
  }

  return NextResponse.json({ ok: true });
}
