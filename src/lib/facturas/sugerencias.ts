// Aggregation logic for invoicing suggestions (sugerencias de facturación).
//
// SMBs invoice nearly the same conceptos to the same customers every month, so
// when creating a new invoice we surface (a) recent line items as autocomplete
// conceptos and (b) recent stamped invoices to prefill from.
//
// This module holds the PURE aggregation — no Prisma, no auth — so it can be
// unit-tested in isolation. The route layer fetches rows and feeds them here.

/** Tratamiento de IVA por concepto, igual que en el formulario de nueva factura. */
export type IvaTratamiento = "16" | "0" | "EXENTO";

/** Fila de impuesto del comprobante (subset de InvoiceTax que nos interesa). */
export interface RawTax {
  tipo: string; // "IVA" | "ISR" | "IEPS"
  factor: string; // "TASA" | "CUOTA" | "EXENTO"
  tasa: number;
  retencion: boolean;
}

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
  /**
   * Tratamiento de IVA derivado de los impuestos del comprobante padre
   * (ver derivarTratamientoIva). Null cuando el comprobante no permite
   * derivarlo sin ambigüedad (mixto, sin filas de IVA, tasa no representable).
   */
  ivaTratamiento?: IvaTratamiento | null;
}

/** A distinct concepto suggestion, ranked by recency + frequency. */
export interface ConceptoSugerido {
  claveProdServ: string;
  descripcion: string;
  valorUnitario: number;
  claveUnidad: string;
  vecesUsado: number;
  ultimoUso: string; // ISO date
  /** Tratamiento de IVA del uso más reciente (null = desconocido). */
  ivaTratamiento: IvaTratamiento | null;
}

/**
 * Deriva el tratamiento de IVA de un comprobante a partir de sus filas de
 * impuesto (InvoiceTax, que vive a nivel comprobante, no por partida).
 *
 * Solo regresa un tratamiento cuando es INEQUÍVOCO: todos los traslados de
 * IVA del comprobante son del mismo tipo. Regresa null cuando:
 *   - no hay traslados de IVA (p.ej. borradores o facturas legacy sin filas),
 *   - el comprobante mezcla tratamientos (16% y tasa 0 en el mismo CFDI: no
 *     sabemos cuál corresponde a cada partida),
 *   - aparece una tasa que el formulario no representa (p.ej. 8% de franja
 *     fronteriza) o un factor CUOTA.
 * El caller decide el default ante null (hoy: "16", el comportamiento previo).
 */
export function derivarTratamientoIva(taxes: RawTax[]): IvaTratamiento | null {
  const traslados = taxes.filter((t) => t.tipo === "IVA" && !t.retencion);
  if (traslados.length === 0) return null;

  const tratamientos = new Set<IvaTratamiento>();
  for (const t of traslados) {
    if (t.factor === "EXENTO") {
      tratamientos.add("EXENTO");
    } else if (t.factor === "TASA" && t.tasa === 0) {
      tratamientos.add("0");
    } else if (t.factor === "TASA" && t.tasa === 0.16) {
      tratamientos.add("16");
    } else {
      // Factor CUOTA o tasa fuera del modelo del formulario: sin opinión.
      return null;
    }
  }
  if (tratamientos.size !== 1) return null;
  return tratamientos.values().next().value ?? null;
}

/**
 * Último tratamiento de IVA conocido por clave de producto/servicio: para
 * cada claveProdServ toma el tratamiento del comprobante MÁS RECIENTE que lo
 * tenga derivado sin ambigüedad. Alimenta el prellenado del selector de IVA
 * cuando el usuario elige una clave que la empresa ya ha facturado.
 */
export function tratamientoPorClave(
  items: Pick<RawItem, "claveProdServ" | "fecha" | "ivaTratamiento">[]
): Record<string, IvaTratamiento> {
  const latest = new Map<string, { fecha: Date; tratamiento: IvaTratamiento }>();
  for (const it of items) {
    if (!it.ivaTratamiento) continue;
    const cur = latest.get(it.claveProdServ);
    if (!cur || it.fecha > cur.fecha) {
      latest.set(it.claveProdServ, { fecha: it.fecha, tratamiento: it.ivaTratamiento });
    }
  }
  const out: Record<string, IvaTratamiento> = {};
  for (const [clave, v] of latest) out[clave] = v.tratamiento;
  return out;
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
      ivaTratamiento: g.latest.ivaTratamiento ?? null,
    }));
}
