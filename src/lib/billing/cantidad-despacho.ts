// ─────────────────────────────────────────────────────────────────────────────
// Regla PURA de cantidad para el plan Despacho. El Price de Stripe del plan
// DESPACHO es per-unit ($299 MXN por empresa al mes) con un mínimo comercial
// de 10 empresas: se cobra siempre max(10, empresas activas administradas).
// Sin dependencias (ni prisma ni Stripe) para que sea importable desde
// componentes de cliente y testeable en aislamiento. El conteo de empresas
// vive en sync-cantidad-despacho.ts (prisma).
// ─────────────────────────────────────────────────────────────────────────────

/** Mínimo comercial de empresas cobradas en el plan Despacho. */
export const DESPACHO_MINIMO_EMPRESAS = 10;

/**
 * Cantidad a cobrar en el item de suscripción DESPACHO dado el número de
 * empresas activas del comprador/despacho: max(10, empresas). Entradas no
 * numéricas o negativas se tratan como 0 (→ mínimo).
 */
export function cantidadDespacho(empresasActivas: number): number {
  const n = Number.isFinite(empresasActivas) ? Math.floor(Math.max(0, empresasActivas)) : 0;
  return Math.max(DESPACHO_MINIMO_EMPRESAS, n);
}
