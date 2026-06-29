import crypto from "crypto";
import { recordCost } from "@/lib/costos/record";
import { twilioWhatsappMicroUsd } from "@/lib/costos/rates";

/**
 * Twilio WhatsApp provider — signature verification (inbound trust boundary)
 * and message send (outbound). We talk to Twilio's REST API directly via
 * `fetch` to avoid pulling in the full `twilio` SDK for two endpoints.
 *
 * Required env:
 *   TWILIO_ACCOUNT_SID    — "AC..."
 *   TWILIO_AUTH_TOKEN     — used both as REST Basic-auth password AND as the
 *                           HMAC key Twilio signs webhooks with
 *   TWILIO_WHATSAPP_FROM  — sender, e.g. "whatsapp:+14155238886"
 * Optional:
 *   TWILIO_WEBHOOK_URL    — the exact public URL Twilio is configured to POST
 *                           to. If unset we reconstruct it from request headers
 *                           (x-forwarded-proto/host), which works behind most
 *                           proxies but is less robust than pinning it.
 */

export function twilioConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_WHATSAPP_FROM
  );
}

/**
 * Validates an inbound Twilio webhook signature.
 *
 * Twilio computes: HMAC-SHA1( authToken, fullUrl + concat(sortedParams) ),
 * base64-encoded, where sortedParams is every POST field sorted by key and
 * concatenated as `key + value` with no separators. We recompute and compare
 * in constant time. Fails closed if the auth token isn't configured.
 *
 * See: https://www.twilio.com/docs/usage/security#validating-requests
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | null
): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token || !signature) return false;

  const data =
    url +
    Object.keys(params)
      .sort()
      .reduce((acc, key) => acc + key + params[key], "");

  const expected = crypto
    .createHmac("sha1", token)
    .update(Buffer.from(data, "utf-8"))
    .digest("base64");

  // Constant-time compare; guard against length mismatch (timingSafeEqual throws).
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Reconstructs the public URL Twilio used, preferring the pinned env value.
 * Twilio signs the URL exactly as it called it (including query string), so
 * mismatches here are the usual cause of signature failures behind proxies.
 */
export function resolveWebhookUrl(req: Request): string {
  if (process.env.TWILIO_WEBHOOK_URL) return process.env.TWILIO_WEBHOOK_URL;
  const h = req.headers;
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const { pathname, search } = new URL(req.url);
  return `${proto}://${host}${pathname}${search}`;
}

/**
 * Every plausible URL Twilio might have signed: the pinned env value (if set)
 * plus URLs reconstructed from the proxy headers (https + the host variants).
 * A pinned URL that's subtly wrong (trailing slash, stale host) is the usual
 * cause of a 403 — verifying against all candidates makes that non-fatal
 * without weakening security: an attacker still can't forge a valid HMAC for
 * ANY url without the auth token.
 */
export function candidateWebhookUrls(req: Request): string[] {
  const urls = new Set<string>();
  if (process.env.TWILIO_WEBHOOK_URL) urls.add(process.env.TWILIO_WEBHOOK_URL);
  const h = req.headers;
  const { pathname, search } = new URL(req.url);
  const hosts = [h.get("x-forwarded-host"), h.get("host")].filter(Boolean) as string[];
  const proto = h.get("x-forwarded-proto") ?? "https";
  for (const host of hosts) {
    urls.add(`${proto}://${host}${pathname}${search}`);
    urls.add(`https://${host}${pathname}${search}`);
  }
  return [...urls];
}

/** True if the signature matches ANY candidate URL. */
export function verifyTwilioSignatureAny(
  urls: string[],
  params: Record<string, string>,
  signature: string | null
): boolean {
  return urls.some((u) => verifyTwilioSignature(u, params, signature));
}

/**
 * Registra (fire-and-forget) el costo de un mensaje de WhatsApp enviado. Se llama
 * SÓLO tras un envío exitoso. Nunca lanza hacia el camino de envío: cualquier
 * fallo al medir se traga aquí.
 *
 * `subtipo` esperado: "whatsapp.template" (plantilla proactiva, fuera de ventana)
 * o "whatsapp.session" (respuesta dentro de la ventana de servicio de 24h).
 */
export function recordWhatsappCost(opts: {
  companyId?: string | null;
  subtipo: "whatsapp.template" | "whatsapp.session";
}): void {
  const kind = opts.subtipo === "whatsapp.session" ? "session" : "template";
  void recordCost({
    categoria: "TWILIO",
    subtipo: opts.subtipo,
    unidades: 1,
    costoMicroUsd: twilioWhatsappMicroUsd(kind),
    companyId: opts.companyId ?? null,
  }).catch(() => {
    // recordCost ya es fire-and-forget; este catch es por si acaso.
  });
}

/** POST compartido al endpoint de Messages de Twilio. Devuelve el SID. */
async function postTwilioMessage(form: URLSearchParams): Promise<string> {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const token = process.env.TWILIO_AUTH_TOKEN!;

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    }
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Twilio send failed (${res.status}): ${detail}`);
  }
  const json = (await res.json()) as { sid?: string };
  return json.sid ?? "";
}

/**
 * Sends a freeform WhatsApp message via Twilio REST. Returns the message SID.
 * Freeform sólo es entregable dentro de la ventana de servicio de 24h (o en el
 * sandbox/dev). Para mensajes proactivos a números "fríos" usa
 * `sendWhatsappTemplate`. Mide el envío como `whatsapp.session`.
 */
export async function sendWhatsappMessage(
  toE164: string,
  body: string,
  costCtx?: { companyId?: string | null }
): Promise<string> {
  const from = process.env.TWILIO_WHATSAPP_FROM!;
  const to = toE164.startsWith("whatsapp:") ? toE164 : `whatsapp:${toE164}`;
  const form = new URLSearchParams({ From: from, To: to, Body: body });

  const messageSid = await postTwilioMessage(form);
  recordWhatsappCost({ companyId: costCtx?.companyId, subtipo: "whatsapp.session" });
  return messageSid;
}

/**
 * Sends a WhatsApp message using a pre-approved Content template (Twilio Content
 * API). Required para mensajes proactivos fuera de la ventana de 24h, que es lo
 * que WhatsApp exige para números "fríos". Usa `ContentSid` (HX...) del Content
 * Template Builder y `ContentVariables` (JSON con el mapa de variables) en lugar
 * de `Body`. Misma auth/From que el envío freeform. Devuelve el SID.
 * Mide el envío como `whatsapp.template`.
 */
export async function sendWhatsappTemplate(
  toE164: string,
  contentSid: string,
  variables?: Record<string, string>,
  costCtx?: { companyId?: string | null }
): Promise<string> {
  const from = process.env.TWILIO_WHATSAPP_FROM!;
  const to = toE164.startsWith("whatsapp:") ? toE164 : `whatsapp:${toE164}`;
  const form = new URLSearchParams({ From: from, To: to, ContentSid: contentSid });
  if (variables && Object.keys(variables).length > 0) {
    form.set("ContentVariables", JSON.stringify(variables));
  }

  const messageSid = await postTwilioMessage(form);
  recordWhatsappCost({ companyId: costCtx?.companyId, subtipo: "whatsapp.template" });
  return messageSid;
}

/** Builds a minimal TwiML response so the webhook can reply in-band. */
export function twiml(message: string): string {
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}

/** Strips the "whatsapp:" prefix and normalizes to bare E.164. */
export function toE164(whatsappAddr: string): string {
  return whatsappAddr.replace(/^whatsapp:/, "").trim();
}

/**
 * Download an inbound media attachment from its Twilio MediaUrl. Twilio media
 * URLs require the account's Basic auth. Returns the bytes + content type.
 */
export async function downloadTwilioMedia(
  url: string
): Promise<{ buffer: Buffer; contentType: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const token = process.env.TWILIO_AUTH_TOKEN!;
  const res = await fetch(url, {
    headers: { Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Twilio media download failed (${res.status})`);
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}
