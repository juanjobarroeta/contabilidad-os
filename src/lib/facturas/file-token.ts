import crypto from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Short-lived signed download tokens for invoice files.
//
// The WhatsApp bot has no session, so it can't use the cookie-authed download
// route. Instead it hands the user a tokenized link that's valid briefly and
// scoped to a single invoice + format. HMAC over AUTH_SECRET; no DB needed.
// ─────────────────────────────────────────────────────────────────────────────

const TTL_MS = 30 * 60 * 1000; // 30 minutes

function secret(): string {
  const s = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET no configurada para firmar enlaces de descarga");
  return s;
}

export function signFileToken(invoiceId: string, format: "xml" | "pdf"): string {
  const exp = Date.now() + TTL_MS;
  const payload = `${invoiceId}.${format}.${exp}`;
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${exp}.${sig}`;
}

export function verifyFileToken(
  invoiceId: string,
  format: "xml" | "pdf",
  token: string
): boolean {
  const [expStr, sig] = token.split(".");
  const exp = parseInt(expStr, 10);
  if (!exp || !sig || Date.now() > exp) return false;
  const expected = crypto
    .createHmac("sha256", secret())
    .update(`${invoiceId}.${format}.${exp}`)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Absolute base URL for building links (prod/staging public URL). */
export function publicBaseUrl(): string {
  return (
    process.env.NEXTAUTH_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "") ||
    ""
  );
}
