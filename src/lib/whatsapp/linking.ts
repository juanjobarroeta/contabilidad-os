import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { sendWhatsappMessage, sendWhatsappTemplate } from "./twilio";
import { normalizePhone } from "./identity";

/**
 * In-app WhatsApp linking: the user enters a number, we send a 6-digit code to
 * it over WhatsApp, and they type it back in the app. Only after a correct code
 * is `verifiedAt` set — which is the ONLY thing the channel trusts. Caller ID
 * alone never authorizes anything.
 */

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function generateCode(): string {
  // 6 digits, zero-padded, from a CSPRNG.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export type StartLinkResult =
  | { ok: true }
  | { ok: false; reason: "taken" | "send_failed" | "template_required" };

/**
 * WhatsApp/Meta bloquea los mensajes freeform iniciados por el negocio (como el
 * código OTP) fuera de la ventana de 24h y exige una plantilla de autenticación
 * aprobada; Twilio lo reporta con el código de error 63016. Lo detectamos en el
 * texto del error (postTwilioMessage adjunta el cuerpo de la respuesta, que
 * incluye el `code`) para dar un mensaje accionable en vez de un "falló" genérico.
 */
function isTemplateRequiredError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("63016");
}

/**
 * Starts (or restarts) linking `phone` to `userId`. Sends a fresh code.
 * Refuses if the number is already verified by a *different* user.
 */
export async function startLink(
  userId: string,
  phone: string
): Promise<StartLinkResult> {
  const phoneE164 = normalizePhone(phone);

  const existing = await prisma.whatsappLink.findUnique({
    where: { phoneE164 },
    select: { userId: true, verifiedAt: true },
  });
  if (existing && existing.verifiedAt && existing.userId !== userId) {
    return { ok: false, reason: "taken" };
  }

  const code = generateCode();
  const codeHash = hashCode(code);
  const codeExpiresAt = new Date(Date.now() + CODE_TTL_MS);

  await prisma.whatsappLink.upsert({
    where: { phoneE164 },
    // Re-claim an unverified row or refresh our own: reset verification state.
    update: { userId, codeHash, codeExpiresAt, attempts: 0, verifiedAt: null },
    create: { phoneE164, userId, codeHash, codeExpiresAt },
  });

  try {
    // El código de verificación es un mensaje iniciado por el negocio. En
    // producción WhatsApp exige una plantilla de autenticación (OTP) aprobada;
    // el código va como variable "1". En sandbox/dev (sin plantilla configurada)
    // caemos al envío freeform, que sólo funciona en la ventana de servicio/sandbox.
    const otpTemplateSid = process.env.TWILIO_OTP_TEMPLATE_SID;
    if (otpTemplateSid) {
      await sendWhatsappTemplate(phoneE164, otpTemplateSid, { "1": code });
    } else {
      await sendWhatsappMessage(
        phoneE164,
        `Tu código de verificación de Contabilidad OS es: ${code}\nVence en 10 minutos. Si no lo solicitaste, ignora este mensaje.`
      );
    }
  } catch (e) {
    if (isTemplateRequiredError(e)) return { ok: false, reason: "template_required" };
    return { ok: false, reason: "send_failed" };
  }

  return { ok: true };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "expired" | "locked" | "mismatch" };

/** Verifies a submitted code and, on success, marks the link verified. */
export async function verifyCode(
  userId: string,
  phone: string,
  code: string
): Promise<VerifyResult> {
  const phoneE164 = normalizePhone(phone);

  const link = await prisma.whatsappLink.findUnique({
    where: { phoneE164 },
    select: {
      id: true,
      userId: true,
      codeHash: true,
      codeExpiresAt: true,
      attempts: true,
    },
  });

  if (!link || link.userId !== userId || !link.codeHash || !link.codeExpiresAt) {
    return { ok: false, reason: "not_found" };
  }
  if (link.attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: "locked" };
  }
  if (link.codeExpiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  if (hashCode(code) !== link.codeHash) {
    await prisma.whatsappLink.update({
      where: { id: link.id },
      data: { attempts: { increment: 1 } },
    });
    return { ok: false, reason: "mismatch" };
  }

  await prisma.whatsappLink.update({
    where: { id: link.id },
    data: { verifiedAt: new Date(), codeHash: null, codeExpiresAt: null, attempts: 0 },
  });
  return { ok: true };
}
