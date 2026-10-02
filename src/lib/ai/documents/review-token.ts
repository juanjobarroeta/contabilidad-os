import { createHmac, timingSafeEqual } from "node:crypto";
import type { DocumentRef } from "./contract";

export type ReviewClaims = { ref: DocumentRef; userId: string; conversationId: string; fingerprint: string; expiresAt: number };
function signature(payload: string) {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("No se pudo verificar la revisión del documento.");
  return createHmac("sha256", secret).update(`mochi-document-review-v1:${payload}`).digest("base64url");
}
export function signReview(claims: Omit<ReviewClaims, "expiresAt">): string {
  const payload = Buffer.from(JSON.stringify({ ...claims, expiresAt: Date.now() + 10 * 60_000 })).toString("base64url");
  return `${payload}.${signature(payload)}`;
}
export function verifyReview(token: string, ref: DocumentRef, userId: string, conversationId: string): ReviewClaims {
  const [payload, sig, extra] = token.split(".");
  const expected = Buffer.from(signature(payload ?? ""));
  const received = Buffer.from(sig ?? "");
  if (extra || expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error("La revisión no es válida. Abre de nuevo el documento.");
  const c = JSON.parse(Buffer.from(payload, "base64url").toString()) as ReviewClaims;
  if (!Number.isFinite(c.expiresAt) || c.expiresAt < Date.now() || c.userId !== userId || c.conversationId !== conversationId ||
      c.ref.companyId !== ref.companyId || c.ref.kind !== ref.kind || c.ref.id !== ref.id || !/^[a-f0-9]{64}$/.test(c.fingerprint)) {
    throw new Error("La revisión venció o corresponde a otro documento, usuario o conversación.");
  }
  return c;
}
