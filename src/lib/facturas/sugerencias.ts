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
  /** Cuenta predial del concepto (arrendamiento), si la partida la llevaba. */
  cuentaPredial?: string | null;
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
  /**
   * Cuenta predial del uso más reciente. Es lo que hace que el arrendamiento
   * se re-facture solo: capturas la cuenta catastral una vez y el mes siguiente
   * viene con el concepto, sin que nadie la vuelva a teclear.
   */
  cuentaPredial: string | null;
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
      cuentaPredial: g.latest.cuentaPredial ?? null,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Facturación recurrente — «vuelve a facturar»
//
// Una PyME no factura cosas distintas cada mes: factura LA MISMA factura, al
// mismo cliente, con los mismos conceptos. El prellenado por cliente ya existía,
// pero obligaba a elegir primero al cliente — justo al revés de como piensa
// quien factura ("toca la renta de Ana", no "veamos qué le facturé a Ana").
//
// Esto agrupa las facturas timbradas por su FORMA (cliente + juego de
// conceptos) y las ordena por frecuencia y recencia, para ofrecer de entrada
// las que se repiten. La plantilla de cada grupo es su factura más reciente:
// los precios que se usan son los últimos, no los del primer mes.
// ─────────────────────────────────────────────────────────────────────────────

/** Partida de una factura, tal como se clona al re-facturar. */
export interface ItemRecurrente {
  claveProdServ: string;
  descripcion: string;
  cantidad: number;
  valorUnitario: number;
  claveUnidad: string;
  cuentaPredial?: string | null;
}

/** Factura timbrada de entrada para el agrupado. */
export interface FacturaParaAgrupar {
  id: string;
  fecha: Date;
  total: number;
  customerId: string | null;
  cliente: string;
  items: ItemRecurrente[];
  ivaTratamiento?: IvaTratamiento | null;
}

/** Una "forma de factura" que la empresa repite. */
export interface FacturaRecurrente {
  /** Factura más reciente del grupo — la plantilla que se clona. */
  facturaId: string;
  customerId: string | null;
  cliente: string;
  total: number;
  /** Cuántas veces se ha facturado esta misma forma. */
  veces: number;
  ultimoUso: string; // ISO
  items: ItemRecurrente[];
  ivaTratamiento: IvaTratamiento;
}

/** Firma de la forma de una factura: cliente + juego de conceptos (sin importar
 *  el orden en que se capturaron ni el espaciado/mayúsculas de la descripción).
 *  Las facturas sin cliente no llegan aquí (ver agruparFacturasRecurrentes). */
export function firmaFactura(f: FacturaParaAgrupar): string {
  const conceptos = f.items
    .map((it) => conceptoKey(it.claveProdServ, it.descripcion))
    .sort()
    .join("|");
  return `${f.customerId ?? "sin-cliente"}::${conceptos}`;
}

/**
 * Agrupa facturas por su forma y devuelve las más repetidas primero (a igual
 * frecuencia, la más reciente). Las facturas sin conceptos se ignoran: no hay
 * nada que volver a facturar.
 */
export function agruparFacturasRecurrentes(
  facturas: FacturaParaAgrupar[],
  top = 6
): FacturaRecurrente[] {
  const grupos = new Map<string, { plantilla: FacturaParaAgrupar; veces: number; ultimoUso: Date }>();

  for (const f of facturas) {
    if (f.items.length === 0) continue;
    // Sin cliente ligado no hay nada que re-facturar: el formulario necesita el
    // receptor para arrancar. Pasa con los CFDIs que entran por descarga masiva
    // del SAT y nunca se emparejaron con una fila de Customer — ofrecerlos
    // dejaba tarjetas que al hacer clic sólo daban error.
    if (!f.customerId) continue;
    const key = firmaFactura(f);
    const g = grupos.get(key);
    if (!g) {
      grupos.set(key, { plantilla: f, veces: 1, ultimoUso: f.fecha });
      continue;
    }
    g.veces += 1;
    if (f.fecha > g.ultimoUso) {
      g.ultimoUso = f.fecha;
      g.plantilla = f; // la plantilla es SIEMPRE la más reciente (precios al día)
    }
  }

  return Array.from(grupos.values())
    .sort((a, b) => {
      const porFrecuencia = b.veces - a.veces;
      if (porFrecuencia !== 0) return porFrecuencia;
      return b.ultimoUso.getTime() - a.ultimoUso.getTime();
    })
    .slice(0, top)
    .map((g) => ({
      facturaId: g.plantilla.id,
      customerId: g.plantilla.customerId,
      cliente: g.plantilla.cliente,
      total: g.plantilla.total,
      veces: g.veces,
      ultimoUso: g.ultimoUso.toISOString(),
      items: g.plantilla.items,
      // Ante ambigüedad (comprobante mixto o sin filas de IVA) se conserva 16%,
      // igual que en el prellenado desde una factura previa.
      ivaTratamiento: g.plantilla.ivaTratamiento ?? "16",
    }));
}
