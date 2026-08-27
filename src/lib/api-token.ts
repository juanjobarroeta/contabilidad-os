/**
 * Bearer JWT auth for cross-origin API clients (construccion-admin, padel,
 * fleet-maintenance, marketing-zionx, etc.). Runs in parallel to NextAuth's
 * session cookie flow used by the contabilidad-os web UI.
 *
 * The auth secret is shared with NextAuth (NEXTAUTH_SECRET / AUTH_SECRET) so
 * there's a single key to rotate. Tokens are HS256-signed JWTs with a short
 * expiry; we validate issuer + audience to refuse re-use across products.
 *
 * TOKEN LIFECYCLE (desde julio 2026; legado retirado en agosto 2026):
 *   - Access token: 1 hora, con `jti` obligatorio y `scope` opcional. Se
 *     renueva con el refresh token opaco (30 días, rotatorio) — ver
 *     src/lib/api-refresh-token.ts y POST /api/auth/token/refresh.
 *   - Tokens legados de 7 días (sin jti, sin revocación): RETIRADOS. La
 *     bandera nunca estuvo activa en prod y su TTL ya venció todos los
 *     emitidos; verifyApiToken ahora exige `jti`, así que la forma legada
 *     queda rechazada estructuralmente aunque alguien firme una.
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
/** Vigencia de los tokens B2C (socios del club, portales de clientes). */
const SEVEN_DAYS = "7d";

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
  /** Identificador único del token; verifyApiToken lo exige presente. */
  jti?: string;
  /** Scopes separados por espacio ("clientes facturas nomina"). Ausente = acceso total. */
  scope?: string;
};

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
 * Verifies a bearer token and returns the payload, or throws.
 * Used by the authz layer when it sees an `Authorization: Bearer <token>`
 * header on an incoming request. Exige `jti`: los tokens legados de 7 días
 * (sin jti) quedaron retirados en agosto 2026 — todos expiraron y la forma
 * se rechaza estructuralmente aunque el firmado sea válido.
 */
export async function verifyApiToken(token: string): Promise<ApiTokenPayload> {
  const { payload } = await jwtVerify(token, getSecretKey(), {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (!payload.sub) throw new Error("Token missing sub");
  if (typeof payload.jti !== "string" || !payload.jti) {
    throw new Error("Token sin jti (forma legada de 7 días, retirada)");
  }
  return {
    sub: payload.sub,
    email: (payload.email as string) ?? "",
    name: (payload.name as string | null) ?? null,
    jti: payload.jti,
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
    // Los socios del club conservan 7 días — el flujo access+refresh aplica
    // sólo a la audiencia staff/API.
    .setExpirationTime(SEVEN_DAYS)
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
    .setExpirationTime(opts?.expiry ?? SEVEN_DAYS)
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

// ─── Automotriz: tokens del portal de clientes de la agencia ─────────────────
// El comprador de un auto entra a un portal de sólo-lectura (estado de cuenta,
// sus CFDIs, sus unidades). NO es un User ni CompanyMember: su cuenta vive en
// AutoPortalAccount con audiencia propia — jamás pasa por requireUser.

const AUTO_PORTAL_AUDIENCE = "automotriz:portal";

export type AutoPortalTokenPayload = {
  sub: string; // AutoPortalAccount id
  companyId: string;
  customerId: string;
  email: string;
};

export async function signAutoPortalToken(
  payload: AutoPortalTokenPayload,
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
    .setAudience(AUTO_PORTAL_AUDIENCE)
    .setExpirationTime(opts?.expiry ?? SEVEN_DAYS)
    .sign(getSecretKey());
}

export async function verifyAutoPortalToken(
  token: string
): Promise<AutoPortalTokenPayload> {
  const { payload } = await jwtVerify(token, getSecretKey(), {
    issuer: ISSUER,
    audience: AUTO_PORTAL_AUDIENCE,
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
