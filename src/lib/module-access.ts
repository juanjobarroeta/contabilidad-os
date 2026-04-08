/**
 * Module-level access control helpers.
 *
 * A CompanyMember row can have an `allowedModules` array that restricts
 * which modules the user can see/use on that company. Empty array means
 * "full access" (backwards compat for every existing row).
 *
 * The "effective modules" a user can see on a company is:
 *
 *   effective =
 *     if allowedModules empty  → company.enabledModules
 *     else                     → company.enabledModules ∩ allowedModules
 *
 * If the user has access via a Despacho (no direct CompanyMember row), the
 * restriction doesn't apply — despacho access is always full, to match
 * the invariant "despacho admins can do anything on their companies."
 *
 * Helpers here are pure functions over data the caller has already loaded;
 * they don't hit the DB. Callers that need to enforce restrictions from
 * scratch should use `requireModule(companyId, modulo, req)` in authz.ts,
 * which runs the DB lookups and throws AuthzError(403) on denial.
 */

import type { ModuloApp } from "@prisma/client";

/**
 * Given a company's enabled modules and a CompanyMember's allowedModules
 * restriction (possibly empty), return the intersection. Empty restriction
 * means "no restriction" so we return the full set.
 */
export function effectiveModules(
  companyEnabled: ModuloApp[],
  allowedModules: ModuloApp[] | null | undefined
): ModuloApp[] {
  if (!allowedModules || allowedModules.length === 0) {
    return companyEnabled;
  }
  const allowed = new Set(allowedModules);
  return companyEnabled.filter((m) => allowed.has(m));
}

/**
 * True if the user has access to the given module on this company, given
 * their CompanyMember restriction. Same semantics as `effectiveModules`
 * but optimized for the single-module check.
 */
export function hasModuleAccess(
  modulo: ModuloApp,
  companyEnabled: ModuloApp[],
  allowedModules: ModuloApp[] | null | undefined
): boolean {
  if (!companyEnabled.includes(modulo)) return false;
  if (!allowedModules || allowedModules.length === 0) return true;
  return allowedModules.includes(modulo);
}
