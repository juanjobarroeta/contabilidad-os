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
 * Verifies the current user is a member of `companyId` and (optionally)
 * has one of the allowed roles. Returns the membership row.
 *
 * Pass `req` to enable bearer-token auth for cross-origin clients.
 */
export async function requireMembership(
  companyId: string,
  allowedRoles?: MemberRole[],
  req?: Request
) {
  const user = await requireUser(req);

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
