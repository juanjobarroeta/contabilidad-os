import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import {
  verifyTwilioSignature,
  resolveWebhookUrl,
  twiml,
  toE164,
  twilioConfigured,
} from "@/lib/whatsapp/twilio";
import {
  resolveSender,
  listAccessibleCompanies,
  userCanAccessCompany,
  setActiveCompany,
  type AccessibleCompany,
} from "@/lib/whatsapp/identity";
import { runWhatsappAgent } from "@/lib/whatsapp/agent";

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

export async function POST(req: Request) {
  // ── 1. Trust boundary: verify Twilio signature. Fail closed. ──────────────
  if (!twilioConfigured()) return ack();

  const url = resolveWebhookUrl(req);
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = typeof v === "string" ? v : "";

  const signature = req.headers.get("x-twilio-signature");
  if (!verifyTwilioSignature(url, params, signature)) {
    return new Response("invalid signature", { status: 403 });
  }

  const from = params.From ?? "";
  const body = (params.Body ?? "").trim();
  const messageSid = params.MessageSid ?? params.SmsMessageSid ?? "";
  const phone = toE164(from);

  if (!phone || !body) return ack();

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

  // ── 4. Resolve which company this turn is about. ──────────────────────────
  let activeCompanyId: string | null = sender.activeCompanyId;

  // Explicit "cambiar empresa" → drop selection and show the menu.
  if (SWITCH_RE.test(body) && companies.length > 1) {
    await setActiveCompany(sender.linkId, null);
    return reply(menuText(companies));
  }

  // Validate any remembered selection still grants access.
  if (activeCompanyId && !(await userCanAccessCompany(sender.userId, activeCompanyId))) {
    activeCompanyId = null;
    await setActiveCompany(sender.linkId, null);
  }

  if (!activeCompanyId) {
    if (companies.length === 1) {
      activeCompanyId = companies[0].id;
      await setActiveCompany(sender.linkId, activeCompanyId);
    } else {
      // Multiple companies and nothing chosen: treat a bare number as a pick,
      // otherwise present the menu. Menu order is deterministic (sorted), so we
      // can resolve the reply without persisting the menu itself.
      const picked = parseSelection(body, companies);
      if (!picked) return reply(menuText(companies));
      activeCompanyId = picked.id;
      await setActiveCompany(sender.linkId, activeCompanyId);
      return reply(
        `Listo, ahora consulto sobre ${picked.razonSocial}. ¿Qué necesitas saber?`
      );
    }
  }

  // ── 5. Load company context + conversation history. ───────────────────────
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

  const recent = await prisma.whatsappMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "desc" },
    take: HISTORY_TURNS,
    select: { role: true, body: true },
  });
  const history: Anthropic.MessageParam[] = recent
    .reverse()
    .map((m) => ({
      role: m.role === "ASSISTANT" ? "assistant" : "user",
      content: m.body,
    }));

  // ── 6. Run the read-only agent. ───────────────────────────────────────────
  let answer: string;
  try {
    answer = await runWhatsappAgent({
      companyId: activeCompanyId,
      company,
      history,
      userText: body,
    });
  } catch (e) {
    console.error("[whatsapp] agent error", e);
    answer =
      "Tuve un problema al procesar tu consulta. Inténtalo de nuevo en un momento.";
  }

  // ── 7. Persist the turn and reply. ────────────────────────────────────────
  await prisma.whatsappMessage.createMany({
    data: [
      { conversationId: conversation.id, role: "USER", body, providerSid: messageSid || null },
      { conversationId: conversation.id, role: "ASSISTANT", body: answer },
    ],
  });

  return reply(answer);
}
