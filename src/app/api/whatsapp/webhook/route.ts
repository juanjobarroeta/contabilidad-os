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
  matchCompanyByName,
  parseCompanySelection,
  type AccessibleCompany,
} from "@/lib/whatsapp/identity";
import { runWhatsappAgent, type WhatsappCompany, type WhatsappCartera } from "@/lib/whatsapp/agent";
import { parseLinkCode, redeemLinkCode } from "@/lib/whatsapp/linking";
import { registrarBitacora } from "@/lib/audit";
import { tryConfirmPendingAction, getPendingAction, stagePendingDeshacerImport } from "@/lib/whatsapp/pending-action";
import { findUltimoLoteImportado, esIntencionDeshacer } from "@/lib/bancos/undo-import";
import { checkWhatsappRateLimit } from "@/lib/whatsapp/rate-limit";
import { effectiveWhatsappPlan } from "@/lib/planes";
import { decideEscrituraUsuario } from "@/lib/subscription";

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

const SWITCH_RE = /\b(cambiar|cambia(r)?\s+(de\s+)?empresa|otra\s+empresa)\b/i;

/**
 * Canjea un código de vinculación (deep-link) enviado por un número AÚN no
 * vinculado y arma la respuesta de confirmación. Si la cuenta tiene exactamente
 * una empresa, la deja activa; si tiene varias, confirma y pregunta cuál activar
 * (mismo menú que el resto del flujo). Bitácora: sólo metadatos (últimos 4 del
 * teléfono). Devuelve el texto a responder, o null si el código no es válido.
 */
async function tryRedeemLinkCode(code: string, phone: string): Promise<string | null> {
  const result = await redeemLinkCode(code, phone);
  if (!result.ok) return null;

  registrarBitacora({
    accion: "whatsapp.vincular",
    userId: result.userId,
    entidad: "WhatsappLink",
    entidadId: result.linkId,
    detalle: { phoneLast4: phone.slice(-4) },
  });

  const companies = await listAccessibleCompanies(result.userId);
  if (companies.length === 0) {
    return (
      "Listo, vinculé este WhatsApp con tu cuenta de Contabilidad OS. Aún no " +
      "tienes empresas activas asignadas; en cuanto tengas una, podré ayudarte."
    );
  }
  if (companies.length === 1) {
    await setActiveCompany(result.linkId, companies[0].id);
    return (
      `Listo, vinculé este WhatsApp con tu cuenta de ${companies[0].razonSocial}. ` +
      "Ya puedes preguntarme sobre tu contabilidad."
    );
  }
  return (
    "Listo, vinculé este WhatsApp con tu cuenta de Contabilidad OS.\n\n" +
    menuText(companies)
  );
}

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
  userId: string;
  cartera: WhatsappCartera;
}): Promise<void> {
  const { companyId, company, conversationId, history, userText, phone, userId, cartera } = opts;
  let answer: string;
  try {
    // Safety gate: if a write (e.g. timbrar) is staged, this message may be the
    // confirmation. Handle it BEFORE the agent — only the exact code executes.
    const confirmed = await tryConfirmPendingAction(conversationId, userText);
    answer = confirmed ?? (await runWhatsappAgent({ companyId, company, history, userText, conversationId, userId, cartera }));
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
  userId: string;
  cartera: WhatsappCartera;
}): Promise<void> {
  const { companyId, company, conversationId, phone, media, history, userId, cartera } = opts;

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
      answer = await runWhatsappAgent({ companyId, company, history, userText: transcript, conversationId, userId, cartera });
    } catch (e) {
      console.error("[whatsapp] agent error (voice)", e);
      answer = "Tuve un problema al procesar tu consulta. Inténtalo de nuevo.";
    }
    return deliver(conversationId, phone, answer);
  }

  // Documents → extractors. Se procesa UN solo adjunto por mensaje (los
  // documentos —sobre todo estados de cuenta por visión— son el paso caro);
  // si vienen más, se pide enviarlos uno por uno.
  const documentos = media.filter((m) => !m.contentType.toLowerCase().startsWith("audio/"));
  const summaries: string[] = [];
  const doc = documentos[0];
  if (doc) {
    try {
      const { buffer, contentType } = await downloadTwilioMedia(doc.url);
      summaries.push(
        await handleWhatsappMedia({
          companyId,
          conversationId,
          buffer,
          contentType: contentType || doc.contentType,
          filename: "",
        })
      );
    } catch (e) {
      console.error("[whatsapp] media error", e);
      summaries.push("No pude procesar el archivo. Inténtalo de nuevo.");
    }
  }
  if (documentos.length > 1) {
    summaries.push(
      `Recibí ${documentos.length} archivos, pero solo procesé el primero. Envíamelos uno por uno, por favor.`
    );
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

  // Vinculación deep-link: el mensaje viene de un número sin enlace verificado y
  // trae un código («Vincular 123456» o los 6 dígitos pelones). Lo canjeamos aquí
  // — es el ÚNICO caso en que un desconocido obtiene una respuesta útil. Un código
  // pelón de un número YA vinculado NO se toca aquí: ése es la confirmación de una
  // escritura pendiente (más abajo), no un intento de vincular.
  if (!sender) {
    const linkAttempt = parseLinkCode(body);
    if (linkAttempt) {
      const confirmation = await tryRedeemLinkCode(linkAttempt.code, phone);
      if (confirmation) return reply(confirmation);
      return reply(
        "Ese código no es válido o expiró. Genera uno nuevo en la app " +
          "(Configuración → Vincular WhatsApp)."
      );
    }
  } else {
    // Número YA vinculado que manda un «Vincular …» explícito: sólo un aviso
    // amable. (El código pelón se deja pasar: es confirmación de escritura.)
    const linkAttempt = parseLinkCode(body);
    if (linkAttempt?.explicit) {
      return reply(
        "Este número ya está vinculado a tu cuenta de Contabilidad OS. " +
          "No necesitas volver a vincularlo; pregúntame lo que necesites."
      );
    }
  }

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

  // Gating de suscripción (bandera SUBSCRIPTION_ENFORCEMENT_ENABLED): con la
  // suscripción vencida/cancelada NO se procesa el mensaje; se contesta cómo
  // reactivar. PAST_DUE (gracia) sigue pasando.
  const decision = await decideEscrituraUsuario(sender.userId);
  if (!decision.permitido) {
    return reply(
      "Tu suscripción de Contabilidad OS no está activa, por lo que el asistente " +
        "de WhatsApp está pausado. Para reactivarlo, inicia sesión en la aplicación " +
        "y activa tu suscripción desde Configuración. Quedamos atentos para ayudarte."
    );
  }

  const companies = await listAccessibleCompanies(sender.userId);
  if (companies.length === 0) {
    return reply("Tu cuenta no tiene empresas activas asignadas todavía.");
  }

  // Encuadre "despacho": el agente necesita saber que atiende una CARTERA (no
  // solo la empresa activa) para razonar preguntas intercompañía.
  const cartera: WhatsappCartera = {
    total: companies.length,
    empresas: companies.map((c) => c.razonSocial),
  };

  // ── 4. Resolve which company this turn is about (fast, inline replies). ────
  let activeCompanyId: string | null = sender.activeCompanyId;

  if (SWITCH_RE.test(body) && companies.length > 1) {
    // Si el usuario nombró la empresa en el mismo mensaje ("cambiar a Reyes
    // Huerta"), cámbiala directo; si no, muestra el menú.
    const named = matchCompanyByName(body.replace(SWITCH_RE, " "), companies);
    if (named) {
      await setActiveCompany(sender.linkId, named.id);
      return reply(`Listo, ahora consulto sobre ${named.razonSocial}. ¿Qué necesitas saber?`);
    }
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
      const picked = parseCompanySelection(body, companies);
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

  // ── Deshacer última importación (respuesta rápida, no pasa por el agente). ──
  // Sólo cuando el mensaje es texto y expresa reversión de una importación. No
  // borra: escenifica y pide "sí". Va después de resolver la empresa activa, así
  // que respeta el foco del despacho.
  if (media.length === 0 && esIntencionDeshacer(body)) {
    const lote = await findUltimoLoteImportado(activeCompanyId);
    if (!lote || lote.borrables === 0) {
      return reply(
        lote
          ? "La última importación ya no tiene movimientos que pueda eliminar (o ya se conciliaron). No deshice nada."
          : "No encuentro una importación reciente que deshacer en esta empresa."
      );
    }
    const de = lote.banco ? `de ${lote.banco} ` : "";
    const resumen = `${lote.borrables} movimiento${lote.borrables === 1 ? "" : "s"} ${de}de la cuenta ${lote.cuentaEtiqueta} de *${company.razonSocial}*`;
    await stagePendingDeshacerImport(conversation.id, activeCompanyId, lote.id, resumen);
    let msg = `Voy a deshacer la última importación: eliminaré ${resumen}.`;
    if (lote.conciliados > 0) {
      msg += ` Conservaré ${lote.conciliados} que ya están conciliados con una factura.`;
    }
    msg += `\n\nResponde *sí* para confirmar, o *cancelar*.`;
    return reply(msg);
  }

  // ── Media branch: forwarded document, photo, or voice note. ───────────────
  // Documents go to the extractors; voice notes are transcribed and answered
  // like a normal question. (Caption + media → the media is the intent.)
  if (media.length > 0) {
    const isAudioOnly = media.every((m) => m.contentType.toLowerCase().startsWith("audio/"));
    // For documents we record a placeholder user turn here; for audio the
    // transcript becomes the user turn inside processMediaTurn.
    if (!isAudioOnly) {
      // Costo-seguridad ANTES de descargar/procesar el documento: la extracción
      // por visión de un estado de cuenta es el paso caro, así que respeta los
      // mismos topes (diario por usuario + presupuesto mensual por empresa)
      // que un turno normal del agente. Respuesta estática, sin LLM.
      const mediaLimit = await checkWhatsappRateLimit({
        linkId: sender.linkId,
        companyId: activeCompanyId,
        plan: effectiveWhatsappPlan({ tier: company.tier, despachoId: company.despachoId }),
      });
      if (!mediaLimit.allowed) {
        return reply(mediaLimit.mensaje ?? "Alcanzaste tu límite de uso del asistente.");
      }
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
      userId: sender.userId,
      cartera,
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
  // Un estado de cuenta pendiente se confirma con "sí" (cuenta por omisión) o con
  // el NÚMERO de la cuenta (1-2 dígitos); las escrituras (timbrar/conciliar), con
  // el código de 6. Ninguna pasa por el agente, así que no se les aplica el tope.
  const siONumero =
    /^\d{1,2}$/.test(body.trim()) ||
    /^(s[íi]|confirm[ao]|confirmar|ok|okay|dale|va|correcto|adelante|de acuerdo)(?![a-zñáéíóúü])/i.test(body.trim()) ||
    /^(cancelar|cancela|no)\b/i.test(body.trim());
  const isConfirmationReply =
    pending != null &&
    (pending.type === "importar_estado" || pending.type === "deshacer_import"
      ? siONumero
      : /\b\d{6}\b/.test(body) || /^(cancelar|cancela|no)\b/i.test(body.trim()));

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
    userId: sender.userId,
    cartera,
  });

  return ack();
}
