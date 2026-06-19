// ─────────────────────────────────────────────────────────────────────────────
// PUE ↔ pago: el IVA de un CFDI sólo es acreditable cuando se pagó efectivamente
// (Art. 5-I LIVA). El motor asume que un PUE se pagó al emitirse; esto cruza esa
// suposición contra la conciliación bancaria para detectar PUE acreditados sin
// pago real. Sólo aplica cuando la empresa concilia banco — si no, no podemos
// juzgarlo y nos quedamos callados (evita falsos positivos masivos).
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";

// Un pago concilia "completo" si cubre el total del CFDI (con holgura de centavos).
const TOL = 0.5;
export function pagadaCompleta(total: number, conciliado: number): boolean {
  return conciliado + TOL >= total;
}

/** ¿La empresa usa conciliación bancaria? Si no hay movimientos, no podemos
 *  juzgar si un PUE se pagó — devolvemos false y los consumidores no marcan nada. */
export async function reconciliacionActiva(companyId: string): Promise<boolean> {
  const n = await prisma.bankTransaction.count({ where: { companyId } });
  return n > 0;
}

/** Suma (en valor absoluto) de los movimientos bancarios MATCHED por invoiceId. */
export async function pagosConciliadosPorInvoice(
  invoiceIds: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (invoiceIds.length === 0) return out;
  const grouped = await prisma.bankTransaction.groupBy({
    by: ["invoiceId"],
    where: { invoiceId: { in: invoiceIds }, status: "MATCHED" },
    _sum: { monto: true },
  });
  for (const g of grouped) {
    if (g.invoiceId) out.set(g.invoiceId, Math.abs(g._sum.monto ?? 0));
  }
  return out;
}
