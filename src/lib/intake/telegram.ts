import { prisma } from "@/lib/prisma";
import { productByKey, telegramConfigured, horaLocal, INTAKE_TZ } from "./config";
import type { CandidateAsk, IntakeContact, IntakeTranscript } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Compuerta de aprobación por Telegram.
//
// Digest en lote (08:00 y 18:00 MX), una TARJETA por ask con teclado inline:
// [✅ Crear] [🔀 Merge] [✏️ Editar] [❌ Descartar]. Al aprobar, el mensaje se
// edita en su lugar con el link del issue — el historial del chat queda como
// bitácora de auditoría. El callback_data viaja como "ask:<id>:<action>".
// ─────────────────────────────────────────────────────────────────────────────

const API = "https://api.telegram.org";

type TgResponse<T> = { ok: boolean; result?: T; description?: string };

export async function tgApi<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN no configurado");
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as TgResponse<T> | null;
  if (!json?.ok) {
    throw new Error(`Telegram ${method} falló: ${json?.description ?? res.status}`);
  }
  return json.result as T;
}

export type AskAction = "approve" | "merge" | "edit" | "discard";

/** Parsea el callback_data "ask:<id>:<action>". Puro y testeado. */
export function parseCallback(data: string | undefined | null): { askId: string; action: AskAction } | null {
  const m = /^ask:([A-Za-z0-9_-]+):(approve|merge|edit|discard)$/.exec(data ?? "");
  return m ? { askId: m[1], action: m[2] as AskAction } : null;
}

/** Marcador embebido en el force_reply de "editar" para reasociar la respuesta. */
export function parseEditMarker(text: string | undefined | null): string | null {
  const m = /#ask:([A-Za-z0-9_-]+)\b/.exec(text ?? "");
  return m ? m[1] : null;
}

const KIND_EMOJI: Record<string, string> = { BUG: "🐞", FEATURE: "✨", QUESTION: "❓", NOISE: "🔇" };

export type AskConRelaciones = CandidateAsk & {
  contact: IntakeContact | null;
  transcript: IntakeTranscript | null;
  dedupeOf: CandidateAsk | null;
};

/** Texto de la tarjeta de un ask. Puro y testeado. */
export function renderAskCard(ask: AskConRelaciones): string {
  const producto = productByKey(ask.product)?.label ?? ask.product ?? "¿producto?";
  const kind = `${KIND_EMOJI[ask.kind] ?? ""} ${ask.kind.toLowerCase()}`;
  const conf = ask.confidence != null ? ` · conf ${ask.confidence.toFixed(2)}` : "";
  const lines = [`🟡 ${producto} · ${kind}${conf}`, "", `*${ask.title}*`, ask.body];
  if (ask.quote) lines.push("", `_"${ask.quote.slice(0, 300)}"_`);

  const fuente: string[] = [];
  if (ask.contact?.displayName || ask.contact?.phoneE164) {
    fuente.push(ask.contact.displayName ?? ask.contact.phoneE164 ?? "");
  }
  if (ask.transcript) {
    const cuando = ask.transcript.startedAt
      ? new Intl.DateTimeFormat("es-MX", { timeZone: INTAKE_TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(ask.transcript.startedAt)
      : "";
    const ts = ask.quoteTsSec != null ? ` @ ${Math.floor(ask.quoteTsSec / 60)}:${String(ask.quoteTsSec % 60).padStart(2, "0")}` : "";
    fuente.push(`Zoom ${cuando}${ts}`.trim());
  } else {
    fuente.push("WhatsApp");
  }
  lines.push("", `— ${fuente.filter(Boolean).join(" · ")}`);
  if (ask.dedupeOf) {
    lines.push(`⚠️ Posible duplicado de: "${ask.dedupeOf.title.slice(0, 80)}"`);
  }
  return lines.join("\n");
}

/** Teclado inline de la tarjeta. Puro. */
export function askKeyboard(ask: AskConRelaciones): { inline_keyboard: { text: string; callback_data: string }[][] } {
  const fila: { text: string; callback_data: string }[] = [
    { text: "✅ Crear", callback_data: `ask:${ask.id}:approve` },
  ];
  if (ask.dedupeOfId) fila.push({ text: "🔀 Merge", callback_data: `ask:${ask.id}:merge` });
  fila.push({ text: "✏️ Editar", callback_data: `ask:${ask.id}:edit` });
  fila.push({ text: "❌ Descartar", callback_data: `ask:${ask.id}:discard` });
  return { inline_keyboard: [fila] };
}

export async function sendAskCard(ask: AskConRelaciones): Promise<string> {
  const msg = await tgApi<{ message_id: number }>("sendMessage", {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text: renderAskCard(ask),
    parse_mode: "Markdown",
    reply_markup: askKeyboard(ask),
  });
  return String(msg.message_id);
}

/** Edita la tarjeta en su lugar (resolución → el chat queda como bitácora). */
export async function updateAskCard(ask: AskConRelaciones, resolution: string): Promise<void> {
  if (!ask.telegramMessageId) return;
  const base = renderAskCard(ask).replace(/^🟡/, "");
  await tgApi("editMessageText", {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    message_id: Number(ask.telegramMessageId),
    text: `${resolution}${base}`,
    parse_mode: "Markdown",
  });
}

/**
 * Digest en lote: manda las tarjetas de los asks PENDING aún no notificados.
 * Corre en la ventana 08:00/18:00 MX (o con force). Idempotente vía notifiedAt.
 * También hace de heartbeat: si el intake lleva >24 h sin recibir NADA, lo
 * avisa — el modo de falla silencioso nº1 es un webhook deshabilitado.
 */
export async function runDigest(opts: { force?: boolean } = {}): Promise<{ enviados: number; skipped?: string }> {
  if (!telegramConfigured()) return { enviados: 0, skipped: "telegram no configurado" };
  const hora = horaLocal();
  if (!opts.force && hora !== 8 && hora !== 18) return { enviados: 0, skipped: `fuera de ventana (hora local ${hora})` };

  const pendientes = await prisma.candidateAsk.findMany({
    where: { status: "PENDING", notifiedAt: null },
    include: { contact: true, transcript: true, dedupeOf: true },
    orderBy: { createdAt: "asc" },
    take: 30,
  });

  let enviados = 0;
  if (pendientes.length > 0) {
    await tgApi("sendMessage", {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: `📥 *Intake*: ${pendientes.length} ask(s) por revisar`,
      parse_mode: "Markdown",
    });
  }
  for (const ask of pendientes) {
    try {
      const messageId = await sendAskCard(ask);
      await prisma.candidateAsk.update({
        where: { id: ask.id },
        data: { notifiedAt: new Date(), telegramMessageId: messageId },
      });
      enviados++;
    } catch (e) {
      console.error("[intake] sendAskCard failed", ask.id, e instanceof Error ? e.message : e);
    }
  }

  // Heartbeat: sólo en el digest matutino para no repetir el aviso.
  if ((opts.force || hora === 8) && enviados === 0) {
    const ultimo = await prisma.rawIntake.findFirst({ orderBy: { receivedAt: "desc" }, select: { receivedAt: true } });
    if (ultimo && Date.now() - ultimo.receivedAt.getTime() > 24 * 60 * 60 * 1000) {
      await tgApi("sendMessage", {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: `⚠️ Intake sin eventos desde hace ${Math.floor((Date.now() - ultimo.receivedAt.getTime()) / 3_600_000)} h — revisa que los webhooks (Twilio/Zoom) sigan activos.`,
      });
    }
  }
  return { enviados };
}
