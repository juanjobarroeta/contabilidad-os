// Aggregation logic for invoicing suggestions (sugerencias de facturación).
//
// SMBs invoice nearly the same conceptos to the same customers every month, so
// when creating a new invoice we surface (a) recent line items as autocomplete
// conceptos and (b) recent stamped invoices to prefill from.
//
// This module holds the PURE aggregation — no Prisma, no auth — so it can be
// unit-tested in isolation. The route layer fetches rows and feeds them here.

/** A line item as read from the DB (subset of InvoiceItem we care about). */
export interface RawItem {
  claveProdServ: string;
  descripcion: string;
  valorUnitario: number;
  claveUnidad: string;
  /** fecha of the parent invoice — drives recency. */
  fecha: Date;
  /** customerId of the parent invoice — null when the invoice has no customer. */
  customerId: string | null;
}

/** A distinct concepto suggestion, ranked by recency + frequency. */
export interface ConceptoSugerido {
  claveProdServ: string;
  descripcion: string;
  valorUnitario: number;
  claveUnidad: string;
  vecesUsado: number;
  ultimoUso: string; // ISO date
}

/**
 * Collapse raw line items into distinct conceptos.
 *
 * Distinct key = claveProdServ + normalized descripción (case/space-insensitive)
 * so "Servicio de consultoría" and "servicio de consultoria " collapse. Within
 * a group we keep the MOST RECENT row's valorUnitario/claveUnidad/casing (the
 * price the customer most likely wants this time) and count occurrences.
 *
 * Ordering: items for `customerId` come first (most relevant), then the rest
 * company-wide. Within each bucket we sort by recency, then frequency. The two
 * buckets are concatenated and de-duplicated (a concepto already surfaced for
 * the customer is not repeated in the company-wide tail), then capped at `top`.
 */
export function aggregateConceptos(
  items: RawItem[],
  customerId: string | null | undefined,
  top = 15
): ConceptoSugerido[] {
  const forCustomer = customerId
    ? rankConceptos(items.filter((it) => it.customerId === customerId))
    : [];
  const companyWide = rankConceptos(items);

  const seen = new Set(forCustomer.map((c) => conceptoKey(c.claveProdServ, c.descripcion)));
  const merged: ConceptoSugerido[] = [...forCustomer];
  for (const c of companyWide) {
    const key = conceptoKey(c.claveProdServ, c.descripcion);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(c);
  }
  return merged.slice(0, top);
}

function conceptoKey(claveProdServ: string, descripcion: string): string {
  return `${claveProdServ}::${descripcion.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

function rankConceptos(items: RawItem[]): ConceptoSugerido[] {
  const groups = new Map<
    string,
    { latest: RawItem; count: number; ultimoUso: Date }
  >();

  for (const it of items) {
    const key = conceptoKey(it.claveProdServ, it.descripcion);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { latest: it, count: 1, ultimoUso: it.fecha });
    } else {
      existing.count += 1;
      if (it.fecha > existing.ultimoUso) {
        existing.ultimoUso = it.fecha;
        existing.latest = it;
      }
    }
  }

  return Array.from(groups.values())
    .sort((a, b) => {
      const byRecency = b.ultimoUso.getTime() - a.ultimoUso.getTime();
      if (byRecency !== 0) return byRecency;
      return b.count - a.count;
    })
    .map((g) => ({
      claveProdServ: g.latest.claveProdServ,
      descripcion: g.latest.descripcion,
      valorUnitario: g.latest.valorUnitario,
      claveUnidad: g.latest.claveUnidad,
      vecesUsado: g.count,
      ultimoUso: g.ultimoUso.toISOString(),
    }));
}
