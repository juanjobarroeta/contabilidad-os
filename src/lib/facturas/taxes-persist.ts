// ─────────────────────────────────────────────────────────────────────────────
// Filas InvoiceTax al TIMBRAR — derivadas de los impuestos que el propio
// request mandó a Facturapi.
//
// El bug que motivó esto: las facturas timbradas desde la app no guardaban
// filas de impuesto (sólo conceptos). El cron de backfill las deriva del
// rawXml… que las timbradas en la app tampoco tienen (el XML vive en el PAC).
// Consecuencia real: NINGUNA factura PPD emitida en la app podía llevar
// complemento de pago — el REP arma los impuestos del documento relacionado
// desde esas filas, y Facturapi rechaza el complemento sin ellas
// («related_documents.0.taxes es requerido»).
//
// Módulo PURO: convierte los impuestos por partida del request en las filas
// agregadas por comprobante que ya usan el importador de XML y el motor de REP.
// ─────────────────────────────────────────────────────────────────────────────

export interface ItemConImpuestos {
  quantity: number;
  product: {
    price: number;
    taxes?: Array<{ type: string; rate: number; factor: string; withholding?: boolean }>;
  };
}

export interface InvoiceTaxRow {
  tipo: "IVA" | "ISR" | "IEPS";
  factor: "TASA" | "EXENTO";
  tasa: number;
  /** Base del impuesto: Σ importes de las partidas que lo llevan. */
  base: number;
  importe: number;
  retencion: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

const TIPOS: Record<string, InvoiceTaxRow["tipo"]> = { IVA: "IVA", ISR: "ISR", IEPS: "IEPS" };
const FACTORES: Record<string, InvoiceTaxRow["factor"]> = {
  TASA: "TASA",
  EXENTO: "EXENTO",
};

/**
 * Agrega los impuestos por partida a filas por comprobante, la misma forma que
 * persisten el importador de XML y el backfill: una fila por combinación
 * (tipo, factor, tasa, retención), con base = Σ importes de sus partidas.
 *
 * Se omiten deliberadamente los tipos/factores fuera del modelo (p. ej. CUOTA
 * de IEPS por unidad): mejor sin fila que con una base inventada — el REP
 * prefiere derivar de totales a partir de una fila incorrecta.
 */
export function invoiceTaxRowsFromItems(items: ItemConImpuestos[]): InvoiceTaxRow[] {
  const grupos = new Map<string, InvoiceTaxRow>();

  for (const it of items) {
    const importeItem = r2(it.quantity * it.product.price);
    for (const t of it.product.taxes ?? []) {
      const tipo = TIPOS[t.type?.toUpperCase() ?? ""];
      const factor = FACTORES[t.factor?.toUpperCase() ?? ""];
      if (!tipo || !factor) continue;
      const retencion = !!t.withholding;
      const tasa = factor === "EXENTO" ? 0 : t.rate;
      const key = `${tipo}|${factor}|${tasa}|${retencion}`;
      const g = grupos.get(key) ?? { tipo, factor, tasa, base: 0, importe: 0, retencion };
      g.base = r2(g.base + importeItem);
      grupos.set(key, g);
    }
  }

  for (const g of grupos.values()) {
    // EXENTO no lleva importe; la fila existe para conservar la base de los
    // actos exentos (insumo de la proporción de acreditamiento, Art. 5 LIVA).
    g.importe = g.factor === "EXENTO" ? 0 : r2(g.base * g.tasa);
  }

  return [...grupos.values()].sort((a, b) => (a.retencion === b.retencion ? 0 : a.retencion ? 1 : -1));
}
