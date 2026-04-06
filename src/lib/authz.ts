import { auth } from "./auth";
import { prisma } from "./prisma";
import type { MemberRole } from "@prisma/client";

export class AuthzError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Returns the authenticated session user id or throws AuthzError(401).
 * Use at the top of every API route that requires auth.
 */
export async function requireUser(): Promise<{ id: string; email: string | null; name: string | null }> {
  const session = await auth();
  if (!session?.user?.id) throw new AuthzError(401, "Unauthorized");
  return {
    id: session.user.id,
    email: session.user.email ?? null,
    name: session.user.name ?? null,
  };
}

/**
 * Verifies the current user is a member of `companyId` and (optionally)
 * has one of the allowed roles. Returns the membership row.
 *
 * Roles are hierarchical for the default check:
 *   OWNER > ADMIN > ACCOUNTANT > VIEWER
 * If no `allowedRoles` is passed, any membership passes.
 */
export async function requireMembership(
  companyId: string,
  allowedRoles?: MemberRole[]
) {
  const user = await requireUser();

  const membership = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: user.id, companyId } },
  });

  if (!membership) throw new AuthzError(403, "Sin acceso a esta empresa");

  if (allowedRoles && !allowedRoles.includes(membership.role)) {
    throw new AuthzError(403, "Sin permisos suficientes");
  }

  return { user, membership };
}

/**
 * Convenience: requires a role that can write data (anything except VIEWER).
 */
export async function requireWriter(companyId: string) {
  return requireMembership(companyId, ["OWNER", "ADMIN", "ACCOUNTANT"]);
}

/**
 * Convenience: requires owner-only operations (delete company, manage members).
 */
export async function requireOwner(companyId: string) {
  return requireMembership(companyId, ["OWNER"]);
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
