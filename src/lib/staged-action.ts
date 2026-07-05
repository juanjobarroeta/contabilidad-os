// ─────────────────────────────────────────────────────────────────────────────
// Tier 3 — "rieles" de escrituras de alto valor por WhatsApp (PARTE PURA).
//
// Una acción irreversible/fiscal (timbrar, complemento de pago…) NUNCA se ejecuta
// desde el chat de WhatsApp con un simple "sí": el asistente la ESCENIFICA y manda
// un deep link a una pantalla de revisión DENTRO de la app. Ahí el usuario, ya
// autenticado por sesión (reautenticación real, resistente a SIM-swap), revisa el
// documento COMPLETO y confirma; recién entonces se ejecuta por la ruta endurecida.
//
// Este módulo tiene las piezas PURAS (mint/hash del token, TTL, reglas de expiración
// y un solo uso, armado del enlace) para poder probarlas sin base de datos. El
// cableado con Prisma/timbrado vive en `staged-action-server.ts` (importa NextAuth /
// Facturapi y no carga bajo vitest).
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import type { StagedActionStatus } from "@prisma/client";

/** Ventana de vida de una acción escenificada. Dinero/fiscal ⇒ ventana corta. */
export const STAGED_ACTION_TTL_MS = 30 * 60 * 1000; // 30 min

/** Tipos de acción que pueden viajar por los rieles (lista blanca). */
export const STAGED_ACTION_TYPES = ["timbrar", "complemento_pago"] as const;
export type StagedActionType = (typeof STAGED_ACTION_TYPES)[number];

export function isStagedActionType(t: string): t is StagedActionType {
  return (STAGED_ACTION_TYPES as readonly string[]).includes(t);
}

/**
 * Acuña un token fresco: uno crudo de alta entropía (viaja en el deep link) y su
 * hash SHA-256 (lo único que se persiste). El token crudo nunca toca la base de
 * datos, así que una fuga de la base no se puede reproducir.
 */
export function mintStagedToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString("base64url");
  return { rawToken, tokenHash: hashStagedToken(rawToken) };
}

/** Hash determinista para buscar una acción por su token crudo. */
export function hashStagedToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/** Instante de expiración para una acción recién escenificada. */
export function stagedActionExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + STAGED_ACTION_TTL_MS);
}

/** Base URL pública (misma resolución que file-token/invitations). */
function publicBase(): string {
  return (
    process.env.NEXTAUTH_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "")
  );
}

/** Arma el deep link absoluto que el usuario abre para revisar y autorizar. */
export function buildAuthorizeUrl(rawToken: string): string {
  return `${publicBase()}/autorizar/${rawToken}`;
}

export type StagedActionGateError = "not_found" | "expired" | "used" | "cancelled";

/**
 * Reja PURA: dada la acción (o null), ¿se puede confirmar ahora?
 *   - not_found → no existe (token inválido)
 *   - cancelled → el usuario ya la descartó
 *   - used      → ya se consumió (EXECUTING/DONE/FAILED). El token es de un solo
 *                 uso; un timbrado fallido NO se reintenta con el mismo token (la
 *                 ambigüedad del timbrado obliga a rearmar desde cero).
 *   - expired   → venció el TTL
 *   - null      → PENDING y vigente ⇒ procede
 */
export function checkStagedActionUsable(
  action: { status: StagedActionStatus; expiresAt: Date } | null,
  now: Date = new Date()
): StagedActionGateError | null {
  if (!action) return "not_found";
  if (action.status === "CANCELLED") return "cancelled";
  if (action.status !== "PENDING") return "used";
  if (action.expiresAt.getTime() <= now.getTime()) return "expired";
  return null;
}

/** Mensaje amable para el usuario según el motivo del rechazo. */
export function stagedActionErrorMessage(err: StagedActionGateError): string {
  switch (err) {
    case "not_found":
      return "Este enlace de autorización no es válido.";
    case "expired":
      return "Este enlace de autorización expiró. Vuelve a solicitar la acción por WhatsApp para generar uno nuevo.";
    case "used":
      return "Esta acción ya se procesó. Si necesitas repetirla, solicítala de nuevo por WhatsApp.";
    case "cancelled":
      return "Esta acción fue cancelada.";
  }
}
