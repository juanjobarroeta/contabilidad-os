/**
 * Bearer JWT auth for cross-origin API clients (construccion-admin, future
 * fleet-maintenance, marketing-zionx, etc.). Runs in parallel to NextAuth's
 * session cookie flow used by the contabilidad-os web UI.
 *
 * The auth secret is shared with NextAuth (NEXTAUTH_SECRET / AUTH_SECRET) so
 * there's a single key to rotate. Tokens are HS256-signed JWTs with a short-
 * ish expiry; we validate issuer + audience to refuse re-use across products.
 */

import { SignJWT, jwtVerify } from "jose";

const ISSUER = "contabilidad-os";
const AUDIENCE = "contabilidad-os:api";
const DEFAULT_EXPIRY = "7d";

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
};

/**
 * Signs a 7-day bearer token for the given user.
 */
export async function signApiToken(payload: ApiTokenPayload): Promise<string> {
  return new SignJWT({ email: payload.email, name: payload.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(DEFAULT_EXPIRY)
    .sign(getSecretKey());
}

/**
 * Verifies a bearer token and returns the payload, or throws.
 * Used by the authz layer when it sees an `Authorization: Bearer <token>`
 * header on an incoming request.
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
    .setExpirationTime(DEFAULT_EXPIRY)
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
