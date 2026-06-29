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
 * Normalizes a phone to bare E.164 ("+" + digits), canonicalizando los números
 * de México a la forma marcable +52##########:
 *
 *  - Limpia espacios, guiones y paréntesis.
 *  - WhatsApp/Twilio entregan el `From` de un móvil de México como +521##########
 *    (el "1" de móvil después del 52), pero el número marcable es +52##########.
 *    Ese "1" no es parte del número, así que lo quitamos para que ambos lados
 *    coincidan en la búsqueda del enlace. Aplica con y sin el "+":
 *      +521##########  / 521##########  → +52##########
 *  - Acepta el número nacional capturado por el usuario con varias formas y lo
 *    lleva a la canónica:
 *      +52##########   → se mantiene
 *      52##########    → +52##########
 *      ##########      (10 dígitos pelones) → se asume México → +52##########
 *  - Sólo aplicamos supuestos de México cuando es inequívoco (10 dígitos pelones,
 *    o empieza con 52/521). Cualquier otro número internacional se respeta tal
 *    cual (sólo se le antepone el "+").
 */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim().replace(/[\s\-()]/g, "");
  const hadPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/^\+*/, "").replace(/\D/g, "");

  // Móvil MX con el "1" extra (con o sin "+"): 521########## → 52##########
  if (/^521\d{10}$/.test(digits)) return `+52${digits.slice(3)}`;
  // Nacional MX ya con lada 52: 52########## → +52##########
  if (/^52\d{10}$/.test(digits)) return `+${digits}`;
  // 10 dígitos pelones, sin "+": se asume México.
  if (!hadPlus && /^\d{10}$/.test(digits)) return `+52${digits}`;

  // Cualquier otro caso (internacional u otra longitud): bare E.164.
  return `+${digits}`;
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
  // guardados antes de canonicalizar.
  //
  // IMPORTANTE: filtramos `verifiedAt: { not: null }` EN LA CONSULTA, no después.
  // Un número puede tener más de una fila por las variantes (p.ej. una verificada
  // +52########## y una vieja sin verificar +521##########); si sólo trajéramos
  // "la primera" y luego revisáramos `verifiedAt`, una fila stale sin verificar
  // podía opacar a la verificada y devolver null ("no vinculado") aunque el
  // usuario SÍ estuviera vinculado. Pedir sólo verificadas evita ese shadowing.
  const link = await prisma.whatsappLink.findFirst({
    where: { phoneE164: { in: phoneVariants(phoneE164) }, verifiedAt: { not: null } },
    orderBy: { verifiedAt: "desc" },
    select: { id: true, userId: true, activeCompanyId: true },
  });
  if (!link) return null;
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
