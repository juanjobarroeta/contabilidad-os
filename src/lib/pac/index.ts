import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// PAC (Proveedor Autorizado de Certificación) routing.
//
// Most customers stamp through Facturapi, which computes + seals the CFDI for
// us. A few customers (currently government dependencias like Gobernación /
// Dirección Administrativa) require the CFDI taxes to be TRUNCATED rather than
// rounded — their portal rejects a CFDI whose IVA/retención is a cent off the
// prefactura. Facturapi cannot truncate (confirmed by their support: the tax is
// not an overridable field, and they don't accept a pre-sealed XML). Finkok is
// a raw-timbrado PAC: we build + seal the XML ourselves, so we control the exact
// (truncated) amounts, which sit at the legal lower bound of SAT's tolerance.
//
// Routing is per-customer via Customer.pacProvider. See lib/pac/finkok.ts for
// the Finkok adapter and lib/facturas/stamp.ts for the dispatch.
// ─────────────────────────────────────────────────────────────────────────────

export type PacProviderId = "facturapi" | "finkok";

/** Narrow a stored string to a known PAC id, defaulting to Facturapi. */
export function asPacProviderId(v: string | null | undefined): PacProviderId {
  return v === "finkok" ? "finkok" : "facturapi";
}

/** Which PAC stamps this customer's CFDIs. Defaults to Facturapi. */
export async function resolvePacProvider(customerId: string): Promise<PacProviderId> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { pacProvider: true },
  });
  return asPacProviderId(customer?.pacProvider);
}
