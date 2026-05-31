import crypto from "crypto";

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

/** Sends a WhatsApp message via Twilio REST. Returns the message SID. */
export async function sendWhatsappMessage(
  toE164: string,
  body: string
): Promise<string> {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const token = process.env.TWILIO_AUTH_TOKEN!;
  const from = process.env.TWILIO_WHATSAPP_FROM!;

  const to = toE164.startsWith("whatsapp:") ? toE164 : `whatsapp:${toE164}`;
  const form = new URLSearchParams({ From: from, To: to, Body: body });

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
