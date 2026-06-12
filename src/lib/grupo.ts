// ─────────────────────────────────────────────────────────────────────────────
// Grupo — empresas del mismo dueño que se facturan entre sí, y detección de
// operaciones INTERCOMPAÑÍA.
//
// Cuando una empresa del grupo emite/recibe un CFDI cuya contraparte es otra
// empresa del MISMO grupo, es una operación entre partes relacionadas — el foco
// de la fiscalización del SAT (Art. 69-B CFF, operaciones simuladas). Estas
// funciones identifican esos CFDIs para exigir materialidad reforzada y para el
// cálculo de comisiones del piloto. PURO de auth: el llamador autoriza primero.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "./prisma";

/** RFCs de las empresas hermanas (mismo grupo) de una empresa dada, sin incluirla. */
export async function rfcsHermanos(companyId: string): Promise<Set<string>> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { grupoId: true },
  });
  if (!company?.grupoId) return new Set();
  const hermanas = await prisma.company.findMany({
    where: { grupoId: company.grupoId, id: { not: companyId } },
    select: { rfc: true },
  });
  return new Set(hermanas.map((c) => c.rfc.trim().toUpperCase()));
}

/**
 * Marca los CFDIs de una empresa cuya contraparte (customer.rfc) es una empresa
 * hermana del mismo grupo → operación intercompañía. Devuelve el set de RFCs
 * hermanos para que el llamador filtre/etiquete sin N+1.
 */
export function esContraparteIntercompania(
  rfcContraparte: string | null | undefined,
  rfcsHermanas: Set<string>
): boolean {
  if (!rfcContraparte) return false;
  return rfcsHermanas.has(rfcContraparte.trim().toUpperCase());
}
