import { auth } from "./auth";
import { prisma } from "./prisma";
import { extractBearer, verifyApiToken } from "./api-token";
import type { MemberRole, ModuloApp } from "@prisma/client";

export class AuthzError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type AuthUser = {
  id: string;
  email: string | null;
  name: string | null;
};

/**
 * Returns the authenticated user for the incoming request, or throws
 * AuthzError(401). Supports two auth paths in parallel:
 *
 *   1. `Authorization: Bearer <jwt>` — used by cross-origin API clients
 *      (construccion-admin, fleet-maintenance, etc.). Validated via
 *      src/lib/api-token.ts against the shared AUTH_SECRET.
 *
 *   2. NextAuth session cookie — used by the contabilidad-os web UI.
 *
 * Callers that can accept API-token auth MUST pass the Request in so the
 * Authorization header is visible. Callers with no Request fall back to
 * session-cookie only (that's the existing behaviour for server components).
 */
export async function requireUser(req?: Request): Promise<AuthUser> {
  // 1. Try bearer token first when we have a Request
  if (req) {
    const token = extractBearer(req);
    if (token) {
      try {
        const payload = await verifyApiToken(token);
        return {
          id: payload.sub,
          email: payload.email || null,
          name: payload.name,
        };
      } catch {
        throw new AuthzError(401, "Token inválido o expirado");
      }
    }
  }

  // 2. Fall back to NextAuth session cookie
  const session = await auth();
  if (!session?.user?.id) throw new AuthzError(401, "Unauthorized");
  return {
    id: session.user.id,
    email: session.user.email ?? null,
    name: session.user.name ?? null,
  };
}

/**
 * Maps a DespachoRole into an implicit MemberRole on every company the
 * despacho owns. Despacho OWNER/ADMIN → company ADMIN; despacho ACCOUNTANT →
 * company ACCOUNTANT. Despacho members never get implicit OWNER of a company
 * (OWNER is reserved for actions like "delete the company" or "transfer to
 * another despacho" which should still be explicit).
 */
function despachoRoleToCompanyRole(r: "OWNER" | "ADMIN" | "ACCOUNTANT"): MemberRole {
  if (r === "OWNER" || r === "ADMIN") return "ADMIN";
  return "ACCOUNTANT";
}

/**
 * Returns the effective membership a user has on a company, considering
 * BOTH direct CompanyMember rows and despacho-based implicit access.
 *
 * Drop-in replacement for `prisma.companyMember.findUnique({ where: { userId_companyId } })`
 * in legacy routes that were written before the despacho layer existed.
 * Returns `null` if the user has no access at all, or a synthetic membership
 * object with the effective role (most-permissive wins).
 *
 * Prefer `requireMembership()` for new code — this helper exists purely for
 * minimal-diff migration of the 22 pre-despacho routes.
 */
export async function getEffectiveCompanyMembership(
  userId: string,
  companyId: string
): Promise<{ userId: string; companyId: string; role: MemberRole } | null> {
  const [direct, company] = await Promise.all([
    prisma.companyMember.findUnique({
      where: { userId_companyId: { userId, companyId } },
    }),
    prisma.company.findUnique({
      where: { id: companyId },
      select: { despachoId: true },
    }),
  ]);

  let despachoMember: { role: "OWNER" | "ADMIN" | "ACCOUNTANT" } | null = null;
  if (company?.despachoId) {
    despachoMember = await prisma.despachoMember.findFirst({
      where: { userId, despachoId: company.despachoId },
      select: { role: true },
    });
  }

  if (!direct && !despachoMember) return null;

  const rank: Record<MemberRole, number> = { OWNER: 4, ADMIN: 3, ACCOUNTANT: 2, VIEWER: 1 };
  let effectiveRole: MemberRole = direct?.role ?? "VIEWER";
  if (despachoMember) {
    const implied = despachoRoleToCompanyRole(despachoMember.role);
    if (rank[implied] > rank[effectiveRole]) effectiveRole = implied;
  }
  if (!direct && despachoMember) {
    effectiveRole = despachoRoleToCompanyRole(despachoMember.role);
  }

  return { userId, companyId, role: effectiveRole };
}

/**
 * Verifies the current user is a member of `companyId` and (optionally)
 * has one of the allowed roles. Returns the membership row (or a synthetic
 * one derived from despacho membership).
 *
 * Access can come from TWO sources:
 *   1. Direct CompanyMember row (explicit invitation to this specific company)
 *   2. DespachoMember row on the despacho that OWNS this company (implicit access)
 *
 * If neither grants access, throws AuthzError(403).
 *
 * When both exist, the more permissive role wins (e.g. if you're a
 * despacho OWNER but also an explicit VIEWER on this company, you get
 * OWNER-equivalent access — being downgraded by an explicit record is
 * confusing UX).
 *
 * Pass `req` to enable bearer-token auth for cross-origin clients.
 */
export async function requireMembership(
  companyId: string,
  allowedRoles?: MemberRole[],
  req?: Request
) {
  const user = await requireUser(req);

  // Load both paths in parallel
  const [direct, company] = await Promise.all([
    prisma.companyMember.findUnique({
      where: { userId_companyId: { userId: user.id, companyId } },
    }),
    prisma.company.findUnique({
      where: { id: companyId },
      select: { despachoId: true },
    }),
  ]);

  let despachoMember: { role: "OWNER" | "ADMIN" | "ACCOUNTANT" } | null = null;
  if (company?.despachoId) {
    despachoMember = await prisma.despachoMember.findFirst({
      where: { userId: user.id, despachoId: company.despachoId },
      select: { role: true },
    });
  }

  if (!direct && !despachoMember) {
    throw new AuthzError(403, "Sin acceso a esta empresa");
  }

  // Determine the effective role: more permissive wins
  // Rank: OWNER(4) > ADMIN(3) > ACCOUNTANT(2) > VIEWER(1)
  const rank: Record<MemberRole, number> = { OWNER: 4, ADMIN: 3, ACCOUNTANT: 2, VIEWER: 1 };
  let effectiveRole: MemberRole = direct?.role ?? "VIEWER";
  if (despachoMember) {
    const impliedRole = despachoRoleToCompanyRole(despachoMember.role);
    if (rank[impliedRole] > rank[effectiveRole]) {
      effectiveRole = impliedRole;
    }
  }
  // If no direct membership but despacho grants access, use only implied
  if (!direct && despachoMember) {
    effectiveRole = despachoRoleToCompanyRole(despachoMember.role);
  }

  if (allowedRoles && !allowedRoles.includes(effectiveRole)) {
    throw new AuthzError(403, "Sin permisos suficientes");
  }

  // Return the direct row if it exists (some callers read its id for audit);
  // otherwise synthesize one. This keeps the shape stable for existing callers.
  const membership = direct ?? {
    id: `despacho:${user.id}:${companyId}`,
    userId: user.id,
    companyId,
    role: effectiveRole,
    createdAt: new Date(),
  };

  return { user, membership: { ...membership, role: effectiveRole } };
}

/**
 * Convenience: requires a role that can write data (anything except VIEWER).
 */
export async function requireWriter(companyId: string, req?: Request) {
  return requireMembership(companyId, ["OWNER", "ADMIN", "ACCOUNTANT"], req);
}

/**
 * Convenience: requires owner-only operations (delete company, manage members).
 */
export async function requireOwner(companyId: string, req?: Request) {
  return requireMembership(companyId, ["OWNER"], req);
}

/**
 * Verifies:
 *   1. the company has contracted (and not disabled) the given product module
 *   2. if `req` is supplied, the authenticated user has the module in their
 *      effective set on this company (i.e. their CompanyMember.allowedModules
 *      is empty OR includes this module, OR they have despacho access which
 *      is always full)
 *
 * Use on routes that belong to an add-on module — e.g. construction routes:
 *
 *   await requireMembership(companyId, undefined, req);
 *   await requireModule(companyId, "CONSTRUCCION", req);
 *
 * Throws AuthzError(403) if the module is missing, disabled, or the user
 * isn't allowed to use it.
 *
 * The `req` param is optional for backwards compatibility — legacy callers
 * that don't supply it only get the company-level check (no per-user
 * restriction enforcement). All new routes should pass `req`.
 */
export async function requireModule(
  companyId: string,
  modulo: ModuloApp,
  req?: Request
) {
  // 1. Company-level check: the module must be enabled on this company
  const row = await prisma.companyModule.findUnique({
    where: { companyId_modulo: { companyId, modulo } },
  });
  if (!row?.habilitado) {
    throw new AuthzError(403, `Módulo ${modulo} no contratado para esta empresa`);
  }

  // 2. User-level check (only when we know who the user is via req)
  if (req) {
    const user = await requireUser(req);

    // Despacho access is always full — skip the per-module check if the
    // user is on a despacho that owns this company.
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { despachoId: true },
    });
    if (company?.despachoId) {
      const despachoMember = await prisma.despachoMember.findFirst({
        where: { userId: user.id, despachoId: company.despachoId },
        select: { id: true },
      });
      if (despachoMember) return row; // full access via despacho
    }

    // Direct membership — check allowedModules
    const direct = await prisma.companyMember.findUnique({
      where: { userId_companyId: { userId: user.id, companyId } },
      select: { allowedModules: true },
    });
    if (!direct) {
      // Already guarded by requireMembership in practice, but defensive:
      throw new AuthzError(403, "Sin acceso a esta empresa");
    }
    const restricted =
      Array.isArray(direct.allowedModules) && direct.allowedModules.length > 0;
    if (restricted && !direct.allowedModules.includes(modulo)) {
      throw new AuthzError(
        403,
        `Tu cuenta no tiene acceso al módulo ${modulo} en esta empresa`
      );
    }
  }

  return row;
}

/**
 * Wraps an API handler so AuthzError is converted to a JSON response.
 * Usage:
 *   export const GET = withAuthz(async (req) => { ... });
 */
export function withAuthz<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (e) {
      if (e instanceof AuthzError) {
        return Response.json({ error: e.message }, { status: e.status });
      }
      throw e;
    }
  };
}
