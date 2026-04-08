// ─────────────────────────────────────────────────────────────────────────────
// Despacho auth helpers — centralized checks for the agency/organization
// layer that sits above individual companies.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "./prisma";
import { AuthzError, requireUser } from "./authz";
import type { DespachoRole } from "@prisma/client";

export type DespachoAccess = {
  userId: string;
  despachoId: string;
  role: DespachoRole;
};

/**
 * Loads the current user's despacho membership (or throws 404 if they don't
 * belong to one). Use in routes that operate on "the user's despacho" without
 * requiring an explicit despacho id from the URL.
 */
export async function requireOwnDespacho(): Promise<DespachoAccess> {
  const user = await requireUser();
  const member = await prisma.despachoMember.findFirst({
    where: { userId: user.id },
    select: { despachoId: true, role: true },
  });
  if (!member) throw new AuthzError(404, "No perteneces a ningún despacho");
  return { userId: user.id, despachoId: member.despachoId, role: member.role };
}

/**
 * Same as requireOwnDespacho but also checks the user has one of the allowed
 * roles in their despacho. Used for admin-only operations (invite users,
 * rename despacho, delete).
 */
export async function requireDespachoRole(allowed: DespachoRole[]): Promise<DespachoAccess> {
  const access = await requireOwnDespacho();
  if (!allowed.includes(access.role)) {
    throw new AuthzError(403, "Sin permisos suficientes en el despacho");
  }
  return access;
}
