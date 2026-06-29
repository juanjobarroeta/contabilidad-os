// ─────────────────────────────────────────────────────────────────────────────
// Server-only authz for client invitations. Kept apart from `invitations.ts`
// (the pure, unit-testable helpers) because this pulls in NextAuth via `authz`,
// which can't load in the vitest environment.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "./prisma";
import { AuthzError, requireUser } from "./authz";

/**
 * Authz for managing client invitations on a company. The acting user must be
 * an OWNER or ADMIN of the DESPACHO that OWNS the target company. (A despacho
 * ACCOUNTANT can operate the company but cannot hand out access; a platform
 * operador can.) Throws AuthzError on any failure.
 *
 * Returns the company + its despachoId so callers don't re-query.
 */
export async function requireDespachoAdminForCompany(
  companyId: string,
  req?: Request
): Promise<{
  userId: string;
  companyId: string;
  despachoId: string;
}> {
  const user = await requireUser(req);

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, despachoId: true },
  });
  if (!company) throw new AuthzError(404, "Empresa no encontrada");
  if (!company.despachoId)
    throw new AuthzError(
      400,
      "La empresa no pertenece a un despacho; no se pueden enviar invitaciones de cliente"
    );

  // Platform operador: full cross-despacho control.
  const operador = await prisma.user.findUnique({
    where: { id: user.id },
    select: { esOperador: true },
  });
  if (operador?.esOperador) {
    return { userId: user.id, companyId, despachoId: company.despachoId };
  }

  const member = await prisma.despachoMember.findFirst({
    where: { userId: user.id, despachoId: company.despachoId },
    select: { role: true },
  });
  if (!member || (member.role !== "OWNER" && member.role !== "ADMIN")) {
    throw new AuthzError(403, "Sin permisos para invitar clientes a esta empresa");
  }

  return { userId: user.id, companyId, despachoId: company.despachoId };
}
