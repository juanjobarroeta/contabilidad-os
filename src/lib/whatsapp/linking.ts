import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { sendWhatsappMessage, sendWhatsappTemplate, toE164 } from "./twilio";
import { normalizePhone } from "./identity";

/**
 * In-app WhatsApp linking. Two flows share the same trust rule: only a *verified*
 * WhatsappLink authorizes anything — caller ID alone never does.
 *
 *  1. Deep-link (default, pre-verificación de Meta): la app genera un código de 6
 *     dígitos (WhatsappLinkCode) y el usuario lo ENVÍA al número del negocio.
 *     Al ser un mensaje iniciado por el usuario abre la ventana de servicio de
 *     24h, así que no requiere plantilla ni verificación de Meta. El webhook
 *     canjea el código y marca el enlace verificado. Ver `parseLinkCode` /
 *     `redeemLinkCode`.
 *  2. OTP (legado): la app envía un código de 6 dígitos al número y el usuario lo
 *     teclea de vuelta. Es un mensaje iniciado por el negocio: fuera de la ventana
 *     de 24h WhatsApp exige una plantilla de autenticación aprobada (error 63016).
 *     Se conserva y se usa sólo cuando `TWILIO_OTP_TEMPLATE_SID` está configurado.
 */

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes (OTP legado)
const LINK_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes (deep-link)
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

// ─────────────────────────────────────────────────────────────────────────────
// Deep-link flow (user-initiated): PURE helpers + DB.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parsea el cuerpo de un mensaje entrante de WhatsApp buscando un intento de
 * vinculación. Acepta:
 *   - «Vincular 483920» (sin distinguir mayúsculas, tolera espacios extra)
 *   - un código pelón de 6 dígitos: «483920»
 * Devuelve el código y si vino con la palabra clave explícita («explicit»), lo
 * que permite al webhook tratar distinto un número YA vinculado que manda un
 * código pelón (que es una confirmación de escritura) vs. un «Vincular …».
 * PURO — sin efectos, testeable.
 */
export function parseLinkCode(
  body: string
): { code: string; explicit: boolean } | null {
  const trimmed = body.trim();
  const explicit = trimmed.match(/^vincular\s+(\d{6})\s*$/i);
  if (explicit) return { code: explicit[1], explicit: true };
  if (/^\d{6}$/.test(trimmed)) return { code: trimmed, explicit: false };
  return null;
}

/**
 * Construye el enlace wa.me para que el usuario abra WhatsApp con el mensaje ya
 * escrito hacia el número del negocio. `twilioFrom` es `TWILIO_WHATSAPP_FROM`,
 * p. ej. "whatsapp:+14155238886". El número va sin "whatsapp:" ni "+", y el texto
 * URL-encodeado: https://wa.me/14155238886?text=Vincular%20483920. PURO.
 */
export function waMeLink(twilioFrom: string, code: string): string {
  const digits = twilioFrom.replace(/^whatsapp:/, "").replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(`Vincular ${code}`)}`;
}

export interface LinkCodeState {
  usedAt: Date | null;
  expiresAt: Date;
}

/**
 * ¿Es canjeable un WhatsappLinkCode? Válido = existe, sin usar y no expirado.
 * PURO — recibe el estado y el "ahora" para poder testear expiración/uso.
 */
export function isLinkCodeValid(
  rec: LinkCodeState | null,
  now: Date = new Date()
): boolean {
  if (!rec) return false;
  if (rec.usedAt) return false;
  return rec.expiresAt.getTime() > now.getTime();
}

/** Genera y persiste un código de vinculación (deep-link) para `userId`. */
export async function generateLinkCode(
  userId: string
): Promise<{ code: string; expiresAt: Date }> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
  await prisma.whatsappLinkCode.create({ data: { code, userId, expiresAt } });
  return { code, expiresAt };
}

export type RedeemResult =
  | { ok: true; userId: string; linkId: string }
  | { ok: false; reason: "invalid" };

/**
 * Canjea un código de vinculación enviado desde `phone`: valida (existe + no
 * expirado + no usado), lo sella de un solo uso de forma atómica, y crea/verifica
 * el WhatsappLink que ata ese teléfono a la cuenta que generó el código.
 *
 * SEGURIDAD: la posesión del teléfono (el mensaje llega DESDE él) más el código
 * (que prueba la sesión autenticada que lo generó) son los dos factores. No se
 * confía en el caller ID para nada más que este emparejamiento.
 */
export async function redeemLinkCode(
  rawCode: string,
  phone: string
): Promise<RedeemResult> {
  const phoneE164 = normalizePhone(phone);
  const now = new Date();

  const rec = await prisma.whatsappLinkCode.findFirst({
    where: { code: rawCode, usedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
    select: { id: true, userId: true },
  });
  if (!rec) return { ok: false, reason: "invalid" };

  // Un solo uso: se sella atómicamente. Si otro entrante ya lo reclamó, se aborta.
  const claimed = await prisma.whatsappLinkCode.updateMany({
    where: { id: rec.id, usedAt: null },
    data: { usedAt: now },
  });
  if (claimed.count === 0) return { ok: false, reason: "invalid" };

  // Crea o (re)verifica el enlace para este teléfono → la cuenta del código.
  const link = await prisma.whatsappLink.upsert({
    where: { phoneE164 },
    update: {
      userId: rec.userId,
      verifiedAt: now,
      codeHash: null,
      codeExpiresAt: null,
      attempts: 0,
    },
    create: { phoneE164, userId: rec.userId, verifiedAt: now },
    select: { id: true },
  });

  return { ok: true, userId: rec.userId, linkId: link.id };
}

/** Número del negocio en E.164 (sin "whatsapp:") para mostrar en la app. */
export function businessNumberE164(twilioFrom: string): string {
  return toE164(twilioFrom);
}
