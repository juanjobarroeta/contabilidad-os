import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import {
  candidateWebhookUrls,
  verifyTwilioSignatureAny,
  sendWhatsappMessage,
  downloadTwilioMedia,
  twiml,
  toE164,
  twilioConfigured,
} from "@/lib/whatsapp/twilio";
import { handleWhatsappMedia } from "@/lib/whatsapp/media";
import { transcribeAudio, transcriptionConfigured } from "@/lib/whatsapp/transcribe";
import {
  resolveSender,
  listAccessibleCompanies,
  userCanAccessCompany,
  setActiveCompany,
  phoneVariants,
  type AccessibleCompany,
} from "@/lib/whatsapp/identity";
import { runWhatsappAgent, type WhatsappCompany } from "@/lib/whatsapp/agent";
import { tryConfirmPendingAction, getPendingAction } from "@/lib/whatsapp/pending-action";
import { checkWhatsappRateLimit } from "@/lib/whatsapp/rate-limit";
import { effectiveWhatsappPlan } from "@/lib/planes";

// Long-running Node server (Railway `next start`), NOT serverless — so the
// background agent work kicked off after we respond keeps running to completion.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HISTORY_TURNS = 10; // last N stored messages replayed as context

function xml(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

function reply(message: string): Response {
  return xml(twiml(message));
}

/** Empty TwiML — acknowledges receipt without sending a message. */
function ack(): Response {
  return xml('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

function menuText(companies: AccessibleCompany[]): string {
  const lines = companies.map((c, i) => `${i + 1}) ${c.razonSocial}`);
  return (
    "¿Sobre cuál empresa quieres consultar? Responde con el número:\n" +
    lines.join("\n")
  );
}

/** Interprets a bare-number reply as a 1-based selection from the menu. */
function parseSelection(
  body: string,
  companies: AccessibleCompany[]
): AccessibleCompany | null {
  const m = body.trim().match(/^(\d{1,2})$/);
  if (!m) return null;
  const idx = parseInt(m[1], 10) - 1;
  return idx >= 0 && idx < companies.length ? companies[idx] : null;
}

const SWITCH_RE = /\b(cambiar|cambia(r)?\s+(de\s+)?empresa|otra\s+empresa)\b/i;

/**
 * The slow part: run the read-only agent and deliver the answer via the Twilio
 * REST API. Runs in the background (NOT awaited by the webhook) so Twilio gets
 * an instant 200 and never hits its ~15s webhook timeout. Failures are reported
 * to the user over REST rather than swallowed.
 */
async function processAgentTurn(opts: {
  companyId: string;
  company: WhatsappCompany;
  conversationId: string;
  history: Anthropic.MessageParam[];
  userText: string;
  phone: string;
}): Promise<void> {
  const { companyId, company, conversationId, history, userText, phone } = opts;
  let answer: string;
  try {
    // Safety gate: if a write (e.g. timbrar) is staged, this message may be the
    // confirmation. Handle it BEFORE the agent — only the exact code executes.
    const confirmed = await tryConfirmPendingAction(conversationId, userText);
    answer = confirmed ?? (await runWhatsappAgent({ companyId, company, history, userText, conversationId }));
  } catch (e) {
    console.error("[whatsapp] agent error", e);
    answer = "Tuve un problema al procesar tu consulta. Inténtalo de nuevo en un momento.";
  }
  try {
    await prisma.whatsappMessage.create({
      data: { conversationId, role: "ASSISTANT", body: answer },
    });
    await sendWhatsappMessage(phone, answer);
  } catch (e) {
    console.error("[whatsapp] failed to deliver answer", e);
  }
}

/**
 * Background: handle inbound media. Documents (statement/CFDI/photo) go to the
 * extractors; audio (voice notes) is transcribed and routed through the chat
 * agent exactly like a typed message. Runs detached so Twilio gets an instant
 * 200; the result is delivered via REST.
 */
async function processMediaTurn(opts: {
  companyId: string;
  company: WhatsappCompany;
  conversationId: string;
  phone: string;
  media: { url: string; contentType: string }[];
  history: Anthropic.MessageParam[];
}): Promise<void> {
  const { companyId, company, conversationId, phone, media, history } = opts;

  // Voice note → transcribe → answer like a normal question.
  const audio = media.find((m) => m.contentType.toLowerCase().startsWith("audio/"));
  if (audio) {
    if (!transcriptionConfigured()) {
      return deliver(conversationId, phone,
        "Por ahora solo leo texto y documentos (PDF, imagen, XML). Escríbeme o mándame el archivo. 🙏");
    }
    let transcript = "";
    try {
      const { buffer, contentType } = await downloadTwilioMedia(audio.url);
      transcript = await transcribeAudio(buffer, contentType || audio.contentType);
    } catch (e) {
      console.error("[whatsapp] transcription error", e);
    }
    if (!transcript) {
      return deliver(conversationId, phone,
        "No pude entender la nota de voz. ¿Puedes repetirla o escribirme el mensaje?");
    }
    // Record the transcript as the user turn, then answer it.
    await prisma.whatsappMessage.create({
      data: { conversationId, role: "USER", body: `🎤 ${transcript}` },
    });
    let answer: string;
    try {
      answer = await runWhatsappAgent({ companyId, company, history, userText: transcript });
    } catch (e) {
      console.error("[whatsapp] agent error (voice)", e);
      answer = "Tuve un problema al procesar tu consulta. Inténtalo de nuevo.";
    }
    return deliver(conversationId, phone, answer);
  }

  // Documents → extractors.
  const summaries: string[] = [];
  for (const m of media) {
    try {
      const { buffer, contentType } = await downloadTwilioMedia(m.url);
      summaries.push(await handleWhatsappMedia({ companyId, buffer, contentType: contentType || m.contentType, filename: "" }));
    } catch (e) {
      console.error("[whatsapp] media error", e);
      summaries.push("No pude procesar uno de los archivos. Inténtalo de nuevo.");
    }
  }
  await deliver(conversationId, phone, summaries.join("\n\n") || "No recibí ningún archivo legible.");
}

/** Persist an assistant message and send it via REST. */
async function deliver(conversationId: string, phone: string, answer: string): Promise<void> {
  try {
    await prisma.whatsappMessage.create({ data: { conversationId, role: "ASSISTANT", body: answer } });
    await sendWhatsappMessage(phone, answer);
  } catch (e) {
    console.error("[whatsapp] failed to deliver", e);
  }
}

export async function POST(req: Request) {
  // ── 1. Trust boundary: verify Twilio signature. Fail closed. ──────────────
  if (!twilioConfigured()) return ack();

  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = typeof v === "string" ? v : "";

  const signature = req.headers.get("x-twilio-signature");
  if (!verifyTwilioSignatureAny(candidateWebhookUrls(req), params, signature)) {
    return new Response("invalid signature", { status: 403 });
  }

  const from = params.From ?? "";
  const body = (params.Body ?? "").trim();
  const messageSid = params.MessageSid ?? params.SmsMessageSid ?? "";
  const phone = toE164(from);

  // Inbound media (forwarded statement / invoice / photo).
  const numMedia = parseInt(params.NumMedia ?? "0", 10) || 0;
  const media: { url: string; contentType: string }[] = [];
  for (let i = 0; i < numMedia; i++) {
    const url = params[`MediaUrl${i}`];
    if (url) media.push({ url, contentType: params[`MediaContentType${i}`] ?? "" });
  }

  // Nothing actionable (no text AND no media) — e.g. an empty/unsupported event.
  if (!phone || (!body && media.length === 0)) return ack();

  // ── 2. Inbound dedup (Twilio retries on timeout). ─────────────────────────
  if (messageSid) {
    const seen = await prisma.whatsappMessage.findFirst({
      where: { providerSid: messageSid },
      select: { id: true },
    });
    if (seen) return ack();
  }

  // ── 3. Identity: verified link only. ──────────────────────────────────────
  const sender = await resolveSender(phone);
  if (!sender) {
    // Diagnóstico operativo: la ruta normal no registra nada, así que un reporte
    // de "no vinculado" era imposible de depurar. Aquí distinguimos las causas
    // (sin enlace / enlace sin verificar / número guardado distinto) registrando
    // el número entrante vs. las variantes buscadas. Sólo metadatos del propio
    // remitente; útil además para confirmar que el webhook llega a este deploy.
    const variants = phoneVariants(phone);
    const anyLink = await prisma.whatsappLink.findFirst({
      where: { phoneE164: { in: variants } },
      select: { phoneE164: true, verifiedAt: true },
    });
    console.warn("[whatsapp] inbound sin sender", {
      from,
      phone,
      variants,
      encontrado: !!anyLink,
      verificado: !!anyLink?.verifiedAt,
      almacenado: anyLink?.phoneE164 ?? null,
    });
    return reply(
      "Hola 👋 Este número no está vinculado a una cuenta de Contabilidad OS. " +
        "Entra a la aplicación y vincula tu WhatsApp desde Ajustes para poder ayudarte."
    );
  }

  const companies = await listAccessibleCompanies(sender.userId);
  if (companies.length === 0) {
    return reply("Tu cuenta no tiene empresas activas asignadas todavía.");
  }

  // ── 4. Resolve which company this turn is about (fast, inline replies). ────
  let activeCompanyId: string | null = sender.activeCompanyId;

  if (SWITCH_RE.test(body) && companies.length > 1) {
    await setActiveCompany(sender.linkId, null);
    return reply(menuText(companies));
  }

  if (activeCompanyId && !(await userCanAccessCompany(sender.userId, activeCompanyId))) {
    activeCompanyId = null;
    await setActiveCompany(sender.linkId, null);
  }

  if (!activeCompanyId) {
    if (companies.length === 1) {
      activeCompanyId = companies[0].id;
      await setActiveCompany(sender.linkId, activeCompanyId);
    } else {
      const picked = parseSelection(body, companies);
      if (!picked) return reply(menuText(companies));
      activeCompanyId = picked.id;
      await setActiveCompany(sender.linkId, activeCompanyId);
      return reply(
        `Listo, ahora consulto sobre ${picked.razonSocial}. ¿Qué necesitas saber?`
      );
    }
  }

  // ── 5. Load context fast, then hand the slow agent work to the background. ─
  const company = await prisma.company.findUnique({
    where: { id: activeCompanyId },
    select: { rfc: true, razonSocial: true, regimenFiscal: true, codigoPostal: true, tier: true, despachoId: true },
  });
  if (!company) return reply("No encontré la empresa seleccionada.");

  const conversation = await prisma.whatsappConversation.upsert({
    where: { linkId_companyId: { linkId: sender.linkId, companyId: activeCompanyId } },
    update: {},
    create: { linkId: sender.linkId, companyId: activeCompanyId },
    select: { id: true },
  });

  // History BEFORE persisting the current turn, so it isn't duplicated.
  const recent = await prisma.whatsappMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "desc" },
    take: HISTORY_TURNS,
    select: { role: true, body: true },
  });
  const history: Anthropic.MessageParam[] = recent
    .reverse()
    .map((m) => ({ role: m.role === "ASSISTANT" ? "assistant" : "user", content: m.body }));

  // ── Media branch: forwarded document, photo, or voice note. ───────────────
  // Documents go to the extractors; voice notes are transcribed and answered
  // like a normal question. (Caption + media → the media is the intent.)
  if (media.length > 0) {
    const isAudioOnly = media.every((m) => m.contentType.toLowerCase().startsWith("audio/"));
    // For documents we record a placeholder user turn here; for audio the
    // transcript becomes the user turn inside processMediaTurn.
    if (!isAudioOnly) {
      await prisma.whatsappMessage.create({
        data: {
          conversationId: conversation.id,
          role: "USER",
          body: body || `[${media.length} archivo(s) adjunto(s)]`,
          providerSid: messageSid || null,
        },
      });
    }
    void processMediaTurn({
      companyId: activeCompanyId,
      company,
      conversationId: conversation.id,
      phone,
      media,
      history,
    });
    return ack();
  }

  // ── Cost-safety: per-user daily + per-company monthly caps. ───────────────
  // Run BEFORE persisting the turn or calling the LLM. We must NOT block a
  // pending 6-digit confirmation (or "cancelar"): those don't hit the agent and
  // resolving a staged write shouldn't be held hostage by a volume cap. Normal
  // agent turns ARE counted and limited. When over a cap we reply with a cheap
  // STATIC message (no LLM) and stop.
  const pending = await getPendingAction(conversation.id);
  const isConfirmationReply =
    pending != null &&
    (/\b\d{6}\b/.test(body) || /^(cancelar|cancela|no)\b/i.test(body.trim()));

  if (!isConfirmationReply) {
    const decision = await checkWhatsappRateLimit({
      linkId: sender.linkId,
      companyId: activeCompanyId,
      // Una empresa de despacho hereda los topes de DESPACHO (el despacho es el
      // operador que paga), no el tier individual de la empresa — que puede ser
      // ASISTENTE (sin WhatsApp) y bloquearía al operador en la primera consulta.
      plan: effectiveWhatsappPlan({ tier: company.tier, despachoId: company.despachoId }),
    });
    if (!decision.allowed) {
      return reply(decision.mensaje ?? "Alcanzaste tu límite de uso del asistente.");
    }
  }

  // Persist the user message now (also dedups Twilio retries via providerSid).
  await prisma.whatsappMessage.create({
    data: {
      conversationId: conversation.id,
      role: "USER",
      body,
      providerSid: messageSid || null,
    },
  });

  // Fire-and-forget the agent + REST delivery; respond to Twilio immediately.
  void processAgentTurn({
    companyId: activeCompanyId,
    company,
    conversationId: conversation.id,
    history,
    userText: body,
    phone,
  });

  return ack();
}
