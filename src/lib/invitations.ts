// ─────────────────────────────────────────────────────────────────────────────
// Client invitations — a despacho admin invites a CLIENT (their customer) to
// access EXACTLY ONE company. Accepting creates a single CompanyMember row and
// NEVER a DespachoMember, so the client can only ever read that one company.
//
// This module holds the PURE, DB-free pieces (token mint/hash, expiry/status
// reasoning, link building) so they can be unit-tested without a database; the
// API routes wire them to Prisma. The server-only authz gate lives in
// `invitations-server.ts` (it pulls in NextAuth and can't load under vitest).
// The invariant we protect: an invited client of company A can never read B.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import type { CompanyInvitationStatus, MemberRole } from "@prisma/client";

/** Days an invite link stays valid after creation. */
export const INVITE_TTL_DAYS = 7;

/**
 * Mints a fresh invite: a high-entropy raw token (delivered to the client) and
 * its SHA-256 hash (the only thing we persist). The raw token never touches the
 * database, so a DB leak can't be replayed.
 */
export function mintInviteToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString("base64url");
  return { rawToken, tokenHash: hashInviteToken(rawToken) };
}

/** Deterministic hash used to look an invite up by its raw token. */
export function hashInviteToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/** Expiry timestamp for a freshly minted invite. */
export function inviteExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export type InviteAcceptError =
  | "not_found"
  | "revoked"
  | "expired"
  | "email_mismatch";

/**
 * Pure gate that decides whether an invite may be accepted by `acceptingEmail`.
 * Returns null when acceptable, or a reason code otherwise. ACCEPTED invites
 * are NOT rejected here — re-accepting is idempotent and handled by the caller
 * (it just re-confirms the existing membership).
 *
 * Keeping this pure makes the expiry / single-use / email-binding rules
 * trivially testable without a database.
 */
export function checkInviteAcceptable(
  invite: {
    status: CompanyInvitationStatus;
    expiresAt: Date;
    email: string;
  } | null,
  acceptingEmail: string,
  now: Date = new Date()
): InviteAcceptError | null {
  if (!invite) return "not_found";
  if (invite.status === "REVOKED") return "revoked";
  // Expiry applies even to already-accepted invites is irrelevant — accepted
  // ones short-circuit in the caller. Only gate PENDING ones on expiry.
  if (invite.status === "PENDING" && invite.expiresAt.getTime() <= now.getTime())
    return "expired";
  if (invite.email.toLowerCase() !== acceptingEmail.toLowerCase())
    return "email_mismatch";
  return null;
}

/** Builds the absolute accept URL the client clicks. */
export function buildAcceptUrl(rawToken: string): string {
  const base =
    process.env.NEXTAUTH_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : "");
  return `${base}/invitacion/${rawToken}`;
}

/** Role a client invite may grant — never elevated to despacho-level access. */
export const CLIENT_INVITE_ROLES = ["VIEWER", "ACCOUNTANT"] as const satisfies readonly MemberRole[];
