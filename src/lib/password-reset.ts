// ─────────────────────────────────────────────────────────────────────────────
// Restablecimiento de contraseña: piezas PURAS (sin DB), espejo del patrón de
// onboarding-invite. El admin de plataforma genera un enlace de un solo uso y
// lo entrega por el canal que ya usa con el cliente (WhatsApp/correo) — no hay
// proveedor SMTP en el stack, así que el sistema no manda correos todavía; el
// día que exista, el mismo token se adjunta a un correo automático.
// El token crudo NUNCA se persiste (sólo su hash SHA-256).
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";

/** Minutos que el enlace permanece válido — corto: es una credencial viva. */
export const PASSWORD_RESET_TTL_MIN = 30;

/** Acuña un token crudo (se entrega una vez) y su hash (lo único que se guarda). */
export function mintResetToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(24).toString("base64url");
  return { rawToken, tokenHash: hashResetToken(rawToken) };
}

/** Hash determinista para buscar el token por su valor crudo. */
export function hashResetToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken.trim()).digest("hex");
}

/** Vencimiento de un token recién creado. */
export function resetTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + PASSWORD_RESET_TTL_MIN * 60 * 1000);
}

export type ResetTokenEstado =
  | { ok: true }
  | { ok: false; motivo: "no_encontrado" | "usado" | "expirado" };

/** Razonamiento PURO de si un token es canjeable. */
export function evaluarResetToken(
  token: { usedAt: Date | null; expiresAt: Date } | null,
  now: Date = new Date()
): ResetTokenEstado {
  if (!token) return { ok: false, motivo: "no_encontrado" };
  if (token.usedAt) return { ok: false, motivo: "usado" };
  if (token.expiresAt.getTime() <= now.getTime()) return { ok: false, motivo: "expirado" };
  return { ok: true };
}

/** Mensaje en español para cada motivo (UI de /reset-password). */
export const MOTIVO_RESET: Record<
  Exclude<ResetTokenEstado, { ok: true }>["motivo"],
  string
> = {
  no_encontrado: "El enlace de restablecimiento no existe.",
  usado: "Este enlace ya se usó. Pide uno nuevo.",
  expirado: "Este enlace expiró (dura 30 minutos). Pide uno nuevo.",
};
