// ─────────────────────────────────────────────────────────────────────────────
// Invitaciones de onboarding: piezas PURAS (sin DB) para poder probarlas sin
// base de datos — mint/hash del token, expiración y razonamiento de estado.
// Las rutas API las cablean a Prisma. El token crudo NUNCA se persiste (sólo su
// hash SHA-256), así que una fuga de la DB no se puede reutilizar. Sirve como
// enlace (?invite=<token>) o como código para teclear: es el mismo valor.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";

/** Días que un enlace de invitación permanece válido tras crearse. */
export const ONBOARDING_INVITE_TTL_DAYS = 14;

/** Acuña un token crudo (se entrega una vez) y su hash (lo único que se guarda). */
export function mintOnboardingToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(24).toString("base64url");
  return { rawToken, tokenHash: hashOnboardingToken(rawToken) };
}

/** Hash determinista para buscar la invitación por su token crudo. */
export function hashOnboardingToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken.trim()).digest("hex");
}

/** Vencimiento de una invitación recién creada. */
export function onboardingInviteExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + ONBOARDING_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export type OnboardingInviteEstado =
  | { ok: true }
  | { ok: false; motivo: "no_encontrada" | "revocada" | "usada" | "expirada" };

/** Razonamiento PURO de si una invitación es canjeable. */
export function evaluarInvitacion(
  invite: { status: string; expiresAt: Date } | null,
  now: Date = new Date()
): OnboardingInviteEstado {
  if (!invite) return { ok: false, motivo: "no_encontrada" };
  if (invite.status === "REVOKED") return { ok: false, motivo: "revocada" };
  if (invite.status === "ACCEPTED") return { ok: false, motivo: "usada" };
  if (invite.expiresAt.getTime() <= now.getTime()) return { ok: false, motivo: "expirada" };
  return { ok: true };
}

/** Mensaje en español para cada motivo (UI del signup). */
export const MOTIVO_INVITACION: Record<
  Exclude<OnboardingInviteEstado, { ok: true }>["motivo"],
  string
> = {
  no_encontrada: "El enlace o código de invitación no existe.",
  revocada: "Esta invitación fue cancelada. Pide una nueva.",
  usada: "Esta invitación ya se usó. Pide una nueva.",
  expirada: "Esta invitación expiró. Pide una nueva.",
};
