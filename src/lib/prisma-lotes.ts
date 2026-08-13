// ─────────────────────────────────────────────────────────────────────────────
// Consultas por lotes cuando el `IN` es grande.
//
// Postgres acepta como máximo 32,767 parámetros por consulta. Prisma normalmente
// parte sola una consulta con un `IN` gigante… salvo si el mismo `where` lleva
// una NEGACIÓN. Ahí no puede, y devuelve:
//
//   "Query parameter limit exceeded error: Parameter limits for this database
//    provider require this query to be split into multiple queries, but the
//    negation filters used prevent the query from being split."
//
// No es teórico: el auditor 24/7 llevaba tiempo fallando en silencio para la
// empresa más grande del sistema (177 mil CFDIs) por exactamente esto. El cron
// contaba el error y seguía devolviendo ok:true, así que nadie se enteró — esa
// empresa simplemente no tenía hallazgos.
//
// El lote va MUY por debajo del tope: una fila puede aportar más de un
// parámetro y el resto del `where` también gasta.
// ─────────────────────────────────────────────────────────────────────────────

/** Tamaño de lote por defecto para listas dentro de un `IN`. */
export const TAM_LOTE = 5_000;

/** Parte una lista en lotes. Un tamaño inválido no produce lotes vacíos infinitos. */
export function enLotes<T>(items: readonly T[], tam: number = TAM_LOTE): T[][] {
  const n = Math.max(1, Math.floor(tam));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/**
 * Corre `consulta` una vez por lote y concatena. Los lotes van en SERIE a
 * propósito: en paralelo, una lista de 200 mil abriría decenas de consultas
 * pesadas a la vez contra la misma base.
 */
export async function consultarPorLotes<T, R>(
  items: readonly T[],
  consulta: (lote: T[]) => Promise<R[]>,
  tam: number = TAM_LOTE
): Promise<R[]> {
  if (items.length === 0) return [];
  const out: R[] = [];
  for (const lote of enLotes(items, tam)) {
    out.push(...(await consulta(lote)));
  }
  return out;
}
