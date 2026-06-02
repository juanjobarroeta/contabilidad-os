// Helpers for reading ISR provisional figures across the row-model transition.
//
// Historically a single IVA_MENSUAL TaxDeclaration row held BOTH the IVA and the
// ISR provisional figures ("we store both in IVA_MENSUAL for now"). The import
// paths, however, already wrote ISR into its own ISR_PROVISIONAL row. We are
// moving everything onto the dedicated ISR_PROVISIONAL row, but legacy folded
// rows still exist in the wild — so reads must accept BOTH shapes.
//
// Rule: for a given periodo, prefer the dedicated ISR_PROVISIONAL row; fall back
// to a legacy IVA_MENSUAL row that still carries a folded isrPagar. This avoids
// both missing imported ISR payments and double-counting during the transition.

export type IsrDeclLike = {
  tipo: string;
  periodo: string;
  isrPagar: number | null;
};

/**
 * Effective ISR provisional `isrPagar` per periodo, deduped across the two row
 * shapes. Only periodos with a non-null ISR amount are included.
 */
export function isrPagarPorPeriodo(rows: IsrDeclLike[]): Map<string, number> {
  const result = new Map<string, number>();
  // First pass: dedicated ISR_PROVISIONAL rows win.
  for (const r of rows) {
    if (r.tipo === "ISR_PROVISIONAL" && r.isrPagar != null) {
      result.set(r.periodo, r.isrPagar);
    }
  }
  // Second pass: legacy folded IVA_MENSUAL rows fill any periodo not already set.
  for (const r of rows) {
    if (r.tipo === "IVA_MENSUAL" && r.isrPagar != null && !result.has(r.periodo)) {
      result.set(r.periodo, r.isrPagar);
    }
  }
  return result;
}

/** Sum of effective ISR provisional payments across the given rows. */
export function sumIsrPagar(rows: IsrDeclLike[]): number {
  let total = 0;
  for (const v of isrPagarPorPeriodo(rows).values()) total += v;
  return total;
}
