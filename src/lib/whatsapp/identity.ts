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

/**
 * Normalizes a phone to bare E.164 ("+" + digits), canonicalizando los móviles
 * mexicanos: WhatsApp/Twilio entregan el `From` de un móvil de México como
 * +521########## (el "1" de móvil después del 52), pero el usuario registra su
 * número como +52##########. Ese "1" no es parte del número marcable, así que lo
 * quitamos para que ambos lados coincidan en la búsqueda del enlace.
 */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim().replace(/[\s\-()]/g, "");
  const e164 = trimmed.startsWith("+") ? trimmed : `+${trimmed.replace(/^\+*/, "")}`;
  return /^\+521\d{10}$/.test(e164) ? `+52${e164.slice(4)}` : e164;
}

/**
 * Las formas con que un mismo número puede aparecer guardado vs. entrante. Para
 * México devuelve la canónica (+52##########) y la variante con "1"
 * (+521##########), para resolver enlaces guardados con cualquiera de las dos
 * (datos previos a la normalización). Para otros países, sólo la canónica.
 */
export function phoneVariants(raw: string): string[] {
  const canon = normalizePhone(raw);
  const mx = /^\+52(\d{10})$/.exec(canon);
  return mx ? [canon, `+521${mx[1]}`] : [canon];
}

/** Returns the verified sender for a phone number, or null if unlinked. */
export async function resolveSender(
  phoneE164: string
): Promise<ResolvedSender | null> {
  // Busca por cualquiera de las variantes (+52 / +521) para tolerar enlaces
  // guardados antes de canonicalizar. `phoneE164` es único, así que findFirst
  // sobre el `in` devuelve a lo más uno.
  const link = await prisma.whatsappLink.findFirst({
    where: { phoneE164: { in: phoneVariants(phoneE164) } },
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
