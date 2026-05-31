import { prisma } from "@/lib/prisma";

/**
 * Identity resolution for the WhatsApp channel.
 *
 * SECURITY: we only ever resolve through a *verified* WhatsappLink. An inbound
 * caller ID with no verified link is an anonymous stranger — we never expose
 * company data to it. Company access mirrors the web app exactly: direct
 * CompanyMember rows plus despacho-owned companies (honoring per-company
 * scoping).
 */

export interface ResolvedSender {
  userId: string;
  linkId: string;
  activeCompanyId: string | null;
}

export interface AccessibleCompany {
  id: string;
  razonSocial: string;
}

/** Normalizes a phone to bare E.164 ("+" + digits). */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim().replace(/[\s\-()]/g, "");
  return trimmed.startsWith("+") ? trimmed : `+${trimmed.replace(/^\+*/, "")}`;
}

/** Returns the verified sender for a phone number, or null if unlinked. */
export async function resolveSender(
  phoneE164: string
): Promise<ResolvedSender | null> {
  const link = await prisma.whatsappLink.findUnique({
    where: { phoneE164: normalizePhone(phoneE164) },
    select: { id: true, userId: true, verifiedAt: true, activeCompanyId: true },
  });
  if (!link || !link.verifiedAt) return null;
  return {
    userId: link.userId,
    linkId: link.id,
    activeCompanyId: link.activeCompanyId,
  };
}

/**
 * Lists every company a user can access — direct memberships plus
 * despacho-owned companies (respecting per-company scope rows). Deduplicated,
 * sorted by razón social for stable disambiguation menus.
 */
export async function listAccessibleCompanies(
  userId: string
): Promise<AccessibleCompany[]> {
  const byId = new Map<string, AccessibleCompany>();

  // 1. Direct memberships
  const direct = await prisma.companyMember.findMany({
    where: { userId },
    select: { company: { select: { id: true, razonSocial: true, isActive: true } } },
  });
  for (const m of direct) {
    if (m.company.isActive) {
      byId.set(m.company.id, { id: m.company.id, razonSocial: m.company.razonSocial });
    }
  }

  // 2. Despacho memberships → companies owned by those despachos
  const despMemberships = await prisma.despachoMember.findMany({
    where: { userId },
    select: { id: true, despachoId: true },
  });

  for (const dm of despMemberships) {
    const scopeRows = await prisma.despachoMemberCompany.findMany({
      where: { despachoMemberId: dm.id },
      select: { companyId: true },
    });
    const scoped = new Set(scopeRows.map((s) => s.companyId));

    const companies = await prisma.company.findMany({
      where: { despachoId: dm.despachoId, isActive: true },
      select: { id: true, razonSocial: true },
    });
    for (const c of companies) {
      // If the member has scope rows, restrict to those; otherwise full access.
      if (scoped.size > 0 && !scoped.has(c.id)) continue;
      byId.set(c.id, { id: c.id, razonSocial: c.razonSocial });
    }
  }

  return [...byId.values()].sort((a, b) =>
    a.razonSocial.localeCompare(b.razonSocial, "es")
  );
}

/** Verifies a user still has access to a specific company (used before serving). */
export async function userCanAccessCompany(
  userId: string,
  companyId: string
): Promise<boolean> {
  const companies = await listAccessibleCompanies(userId);
  return companies.some((c) => c.id === companyId);
}

/** Persists the chosen active company on the link. */
export async function setActiveCompany(
  linkId: string,
  companyId: string | null
): Promise<void> {
  await prisma.whatsappLink.update({
    where: { id: linkId },
    data: { activeCompanyId: companyId },
  });
}
