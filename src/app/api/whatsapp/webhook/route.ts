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
import {
  resolveSender,
  listAccessibleCompanies,
  userCanAccessCompany,
  setActiveCompany,
  type AccessibleCompany,
} from "@/lib/whatsapp/identity";
import { runWhatsappAgent, type WhatsappCompany } from "@/lib/whatsapp/agent";

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
    answer = await runWhatsappAgent({ companyId, company, history, userText });
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
 * Background: download inbound media attachment(s), route to the right
 * extractor (statement / CFDI), and deliver the summary via REST. Like the
 * agent turn, runs detached so Twilio gets an instant 200.
 */
async function processMediaTurn(opts: {
  companyId: string;
  conversationId: string;
  phone: string;
  media: { url: string; contentType: string }[];
}): Promise<void> {
  const { companyId, conversationId, phone, media } = opts;
  const summaries: string[] = [];
  for (const m of media) {
    try {
      const { buffer, contentType } = await downloadTwilioMedia(m.url);
      const summary = await handleWhatsappMedia({
        companyId,
        buffer,
        contentType: contentType || m.contentType,
        filename: "",
      });
      summaries.push(summary);
    } catch (e) {
      console.error("[whatsapp] media error", e);
      summaries.push("No pude procesar uno de los archivos. Inténtalo de nuevo.");
    }
  }
  const answer = summaries.join("\n\n") || "No recibí ningún archivo legible.";
  try {
    await prisma.whatsappMessage.create({ data: { conversationId, role: "ASSISTANT", body: answer } });
    await sendWhatsappMessage(phone, answer);
  } catch (e) {
    console.error("[whatsapp] failed to deliver media summary", e);
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
    select: { rfc: true, razonSocial: true, regimenFiscal: true, codigoPostal: true },
  });
  if (!company) return reply("No encontré la empresa seleccionada.");

  const conversation = await prisma.whatsappConversation.upsert({
    where: { linkId_companyId: { linkId: sender.linkId, companyId: activeCompanyId } },
    update: {},
    create: { linkId: sender.linkId, companyId: activeCompanyId },
    select: { id: true },
  });

  // ── Media branch: a forwarded statement / invoice / photo. ────────────────
  // Route to the extractors instead of the chat agent. (If the message has
  // BOTH media and a caption, we process the media — the document is the intent.)
  if (media.length > 0) {
    await prisma.whatsappMessage.create({
      data: {
        conversationId: conversation.id,
        role: "USER",
        body: body || `[${media.length} archivo(s) adjunto(s)]`,
        providerSid: messageSid || null,
      },
    });
    void processMediaTurn({
      companyId: activeCompanyId,
      conversationId: conversation.id,
      phone,
      media,
    });
    return ack();
  }

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
