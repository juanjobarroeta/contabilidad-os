/**
 * Bearer JWT auth for cross-origin API clients (construccion-admin, padel,
 * fleet-maintenance, marketing-zionx, etc.). Runs in parallel to NextAuth's
 * session cookie flow used by the contabilidad-os web UI.
 *
 * The auth secret is shared with NextAuth (NEXTAUTH_SECRET / AUTH_SECRET) so
 * there's a single key to rotate. Tokens are HS256-signed JWTs with a short
 * expiry; we validate issuer + audience to refuse re-use across products.
 *
 * TOKEN LIFECYCLE (desde julio 2026):
 *   - Access token: 1 hora, con `jti` y `scope` opcional. Se renueva con el
 *     refresh token opaco (30 días, rotatorio) — ver src/lib/api-refresh-token.ts
 *     y POST /api/auth/token/refresh.
 *   - Tokens legados de 7 días: siguen VERIFICANDO hasta expirar de forma
 *     natural (mismo issuer/audience/secreto — nada que hacer aquí). Su
 *     EMISIÓN sólo queda disponible con LEGACY_API_TOKENS_ENABLED="true" y
 *     body { legacy: true }; ver POST /api/auth/token.
 *
 * DECISIÓN — sin denylist de `jti` para access tokens: con TTL de 1 hora, la
 * ventana de exposición de un access token filtrado es acotada; revocar el
 * refresh token (GET/DELETE /api/me/tokens) corta el acceso en menos de una
 * hora. Mantener una denylist consultada en CADA request costaría un viaje a
 * BD por verificación para cubrir esa misma hora. La palanca de emergencia
 * sigue siendo rotar AUTH_SECRET, que invalida TODOS los JWT al instante.
 */

import { SignJWT, jwtVerify } from "jose";
import { randomUUID } from "node:crypto";

const ISSUER = "contabilidad-os";
const AUDIENCE = "contabilidad-os:api";
/** Vigencia de los access tokens del flujo con refresh. */
export const ACCESS_TOKEN_EXPIRY_SECONDS = 60 * 60; // 1 hora
/** Vigencia legada (emisión sólo con LEGACY_API_TOKENS_ENABLED="true"). */
const LEGACY_EXPIRY = "7d";

function getSecretKey(): Uint8Array {
  const raw =
    process.env.AUTH_SECRET ??
    process.env.NEXTAUTH_SECRET ??
    "";
  if (!raw) {
    throw new Error(
      "AUTH_SECRET (or NEXTAUTH_SECRET) must be set to sign API tokens"
    );
  }
  return new TextEncoder().encode(raw);
}

export type ApiTokenPayload = {
  sub: string;      // user id
  email: string;
  name: string | null;
  /** Identificador único del token (sólo en access tokens del flujo nuevo). */
  jti?: string;
  /** Scopes separados por espacio ("clientes facturas nomina"). Ausente = acceso total. */
  scope?: string;
};

/** True si la emisión de tokens legados de 7 días está habilitada por env. */
export function legacyApiTokensEnabled(): boolean {
  return process.env.LEGACY_API_TOKENS_ENABLED === "true";
}

/**
 * Signs a 1-hour access token for the given user, with a unique `jti` and an
 * optional space-separated `scope` claim. Pair it with a refresh token
 * (src/lib/api-refresh-token.ts) so clients can renew without re-sending
 * credentials.
 */
export async function signApiToken(
  payload: ApiTokenPayload,
  opts?: { scope?: string | null }
): Promise<string> {
  const scope = opts?.scope?.trim();
  return new SignJWT({
    email: payload.email,
    name: payload.name,
    ...(scope ? { scope } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setJti(randomUUID())
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${ACCESS_TOKEN_EXPIRY_SECONDS}s`)
    .sign(getSecretKey());
}

/**
 * Signs a LEGACY 7-day bearer token (no jti, no scope) — the pre-refresh-flow
 * shape. Issuance is gated behind LEGACY_API_TOKENS_ENABLED="true"; existing
 * legacy tokens keep verifying regardless (same issuer/audience/secret).
 */
export async function signLegacyApiToken(payload: ApiTokenPayload): Promise<string> {
  return new SignJWT({ email: payload.email, name: payload.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(LEGACY_EXPIRY)
    .sign(getSecretKey());
}

/**
 * Verifies a bearer token and returns the payload, or throws.
 * Used by the authz layer when it sees an `Authorization: Bearer <token>`
 * header on an incoming request. Accepts BOTH new short-lived access tokens
 * (with jti/scope) and legacy 7-day tokens (without) — back-compat is load-
 * bearing here: live satellites still hold legacy tokens.
 */
export async function verifyApiToken(token: string): Promise<ApiTokenPayload> {
  const { payload } = await jwtVerify(token, getSecretKey(), {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (!payload.sub) throw new Error("Token missing sub");
  return {
    sub: payload.sub,
    email: (payload.email as string) ?? "",
    name: (payload.name as string | null) ?? null,
    ...(typeof payload.jti === "string" ? { jti: payload.jti } : {}),
    ...(typeof payload.scope === "string" && payload.scope
      ? { scope: payload.scope }
      : {}),
  };
}

/**
 * Extracts a bearer token from a Request's Authorization header.
 * Returns null if the header is missing or not a Bearer token.
 */
export function extractBearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!h) return null;
  const match = /^Bearer\s+(.+)$/i.exec(h);
  return match ? match[1].trim() : null;
}

// ─── Club member (B2C) tokens ────────────────────────────────────────────────
//
// Members of the padel club ("theclubpadel" satellite) are a B2C identity
// distinct from the accounting `User`/`CompanyMember` (staff). They get their
// own token, signed with the SAME shared secret but a DIFFERENT audience so a
// member token can never be replayed against a staff route (and vice versa) —
// verifyApiToken refuses it on the audience check, and verifyClubMemberToken
// refuses staff tokens for the same reason. The token also carries the member's
// `companyId` (the club they belong to) so member routes can scope without a
// second lookup.

const MEMBER_AUDIENCE = "theclubpadel:member";

export type ClubMemberTokenPayload = {
  sub: string; // ClubMember id
  email: string;
  name: string | null;
  companyId: string; // the club (Company) this member belongs to
};

/** Signs a 7-day bearer token for a club member. */
export async function signClubMemberToken(
  payload: ClubMemberTokenPayload
): Promise<string> {
  return new SignJWT({
    email: payload.email,
    name: payload.name,
    companyId: payload.companyId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(MEMBER_AUDIENCE)
    // Los tokens de socios del club conservan los 7 días de siempre — el flujo
    // access+refresh aplica sólo a la audiencia staff/API.
    .setExpirationTime(LEGACY_EXPIRY)
    .sign(getSecretKey());
}

/** Verifies a club member token and returns the payload, or throws. */
export async function verifyClubMemberToken(
  token: string
): Promise<ClubMemberTokenPayload> {
  const { payload } = await jwtVerify(token, getSecretKey(), {
    issuer: ISSUER,
    audience: MEMBER_AUDIENCE,
  });
  if (!payload.sub) throw new Error("Token missing sub");
  if (!payload.companyId) throw new Error("Token missing companyId");
  return {
    sub: payload.sub,
    email: (payload.email as string) ?? "",
    name: (payload.name as string | null) ?? null,
    companyId: payload.companyId as string,
  };
}

// ─── Purificadora: tokens del portal de clientes ─────────────────────────────
// El cliente-empresa de la purificadora (SHIRUSHI, GYPSA…) entra a un portal
// de sólo-lectura para ver sus CFDIs y su consumo de garrafones. NO es un
// User ni un CompanyMember: su cuenta vive en PurifPortalAccount y su token
// lleva una audiencia propia, así que jamás pasa por requireUser/membership.

const PURIF_PORTAL_AUDIENCE = "purificadora:portal";

export type PurifPortalTokenPayload = {
  sub: string; // PurifPortalAccount id
  companyId: string;
  customerId: string;
  email: string;
};

/**
 * Firma un token para una cuenta del portal de clientes. 7 días por default;
 * la vista de administrador («ver como cliente») pide una vigencia corta.
 */
export async function signPurifPortalToken(
  payload: PurifPortalTokenPayload,
  opts?: { expiry?: string }
): Promise<string> {
  return new SignJWT({
    companyId: payload.companyId,
    customerId: payload.customerId,
    email: payload.email,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(PURIF_PORTAL_AUDIENCE)
    .setExpirationTime(opts?.expiry ?? LEGACY_EXPIRY)
    .sign(getSecretKey());
}

/** Verifica un token del portal y devuelve el payload, o lanza. */
export async function verifyPurifPortalToken(
  token: string
): Promise<PurifPortalTokenPayload> {
  const { payload } = await jwtVerify(token, getSecretKey(), {
    issuer: ISSUER,
    audience: PURIF_PORTAL_AUDIENCE,
  });
  if (!payload.sub || !payload.companyId || !payload.customerId) {
    throw new Error("Token de portal incompleto");
  }
  return {
    sub: payload.sub,
    companyId: payload.companyId as string,
    customerId: payload.customerId as string,
    email: (payload.email as string) ?? "",
  };
}
