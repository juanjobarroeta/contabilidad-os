// ─────────────────────────────────────────────────────────────────────────────
// Normalización de folios fiscales (UUID) para EMPATAR entre fuentes: los REP
// escriben IdDocumento en MAYÚSCULAS, mientras que las facturas timbradas vía
// PAC (Facturapi) se guardan en minúsculas. Un empate sensible a mayúsculas
// falla EN SILENCIO — caso real: los complementos de pago de junio de una
// empresa existían con todo y nodos de pago parseados, pero el motor de IVA
// los descartaba como "padre desconocido" y el mes salía subdeclarado ~$8,300.
// Mismo bug ya corregido antes en cancel-sync (upper(uuid)); estos helpers lo
// resuelven en todos los cruces Invoice.uuid ↔ PagoDoctoRelacionado.parentUuid.
// ─────────────────────────────────────────────────────────────────────────────

/** Forma canónica de un UUID para llaves de Map/Set (trim + MAYÚSCULAS). */
export function normalizarUuid(u: string): string {
  return u.trim().toUpperCase();
}

/**
 * Variantes (MAYÚSCULAS y minúsculas) de cada UUID, para filtros `in` de
 * Prisma — la comparación en Postgres es sensible a mayúsculas y los UUID
 * reales vienen en una u otra forma completa (nunca mixta). Deduplicado.
 */
export function variantesUuid(uuids: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const u of uuids) {
    if (!u) continue;
    const t = u.trim();
    if (!t) continue;
    out.add(t.toUpperCase());
    out.add(t.toLowerCase());
  }
  return [...out];
}
