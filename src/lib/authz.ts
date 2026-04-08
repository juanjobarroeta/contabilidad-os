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
 * Verifies the company has contracted (and not disabled) the given product module.
 * Use on routes that belong to an add-on module — e.g. construction routes call
 * `await requireModule(companyId, "CONSTRUCCION")` after `requireMembership`.
 *
 * Throws AuthzError(403) if the module is missing or disabled.
 */
export async function requireModule(companyId: string, modulo: ModuloApp) {
  const row = await prisma.companyModule.findUnique({
    where: { companyId_modulo: { companyId, modulo } },
  });
  if (!row?.habilitado) {
    throw new AuthzError(403, `Módulo ${modulo} no contratado para esta empresa`);
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
