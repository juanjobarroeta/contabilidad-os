/**
 * Authorization for padel club MEMBERS (B2C self-service).
 *
 * This is the member-facing counterpart to src/lib/authz.ts (which is for
 * staff = accounting Users/CompanyMembers). Members authenticate with a token
 * issued by POST /api/padel/auth/token, signed with audience
 * "theclubpadel:member" (see src/lib/api-token.ts). A member is always scoped
 * to a single club (companyId) and can only ever read/write their OWN rows.
 *
 * Routes under /api/padel/me/* use requireClubMember(); routes that staff hit
 * (courts admin, charge, etc.) use the staff helpers in authz.ts instead.
 */

import { prisma } from "./prisma";
import { extractBearer, verifyClubMemberToken } from "./api-token";
import { AuthzError } from "./authz";

export type ClubMemberAuth = {
  id: string;
  companyId: string;
  email: string;
  nombre: string;
};

/**
 * Resolves the authenticated club member for a request, or throws AuthzError.
 * Verifies the bearer token, loads the member, and confirms the member is
 * active AND that the club still has the PADEL module enabled (fail-closed: a
 * club that loses the module can't have members booking through the API).
 */
export async function requireClubMember(req: Request): Promise<ClubMemberAuth> {
  const token = extractBearer(req);
  if (!token) throw new AuthzError(401, "Token requerido");

  let payload;
  try {
    payload = await verifyClubMemberToken(token);
  } catch {
    throw new AuthzError(401, "Token inválido o expirado");
  }

  const member = await prisma.clubMember.findUnique({
    where: { id: payload.sub },
    select: { id: true, companyId: true, email: true, nombre: true, activo: true },
  });
  if (!member || !member.activo) {
    throw new AuthzError(401, "Miembro no encontrado o inactivo");
  }

  // Defensive: the token carries companyId, but trust the DB row.
  await requireClubModule(member.companyId);

  return {
    id: member.id,
    companyId: member.companyId,
    email: member.email,
    nombre: member.nombre,
  };
}

/**
 * Confirms a company has the PADEL module contracted + enabled. Used by both
 * member routes (no staff user in context) and the member signup route.
 */
export async function requireClubModule(companyId: string): Promise<void> {
  const row = await prisma.companyModule.findUnique({
    where: { companyId_modulo: { companyId, modulo: "PADEL" } },
    select: { habilitado: true },
  });
  if (!row?.habilitado) {
    throw new AuthzError(403, "Módulo PADEL no contratado para este club");
  }
}
