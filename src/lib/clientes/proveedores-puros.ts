// ─────────────────────────────────────────────────────────────────────────────
// "Proveedor puro": contraparte que SÓLO nos ha facturado (todos sus
// comprobantes son EGRESO) — vive en Proveedores, no en Clientes. Se calcula
// con dos conjuntos indexados (quién tiene alguna factura, quién tiene alguna
// que no sea EGRESO) en vez de subconsultas correlacionadas por cliente, que
// con 13k CFDIs tardaban decenas de segundos.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";

/** Puro: aparece en `conAlguna` y no en `conNoEgreso`. */
export function proveedoresPuros(
  conAlguna: Iterable<string>,
  conNoEgreso: Iterable<string>,
): Set<string> {
  const noEgreso = new Set(conNoEgreso);
  const out = new Set<string>();
  for (const id of conAlguna) if (!noEgreso.has(id)) out.add(id);
  return out;
}

/** Ids de Customer de la empresa que son proveedores puros. Dos GROUP BY
 *  sobre índices con prefijo companyId; nada por-cliente. */
export async function idsProveedoresPuros(companyId: string): Promise<Set<string>> {
  const [conAlguna, conNoEgreso] = await Promise.all([
    prisma.invoice.groupBy({
      by: ["customerId"],
      where: { companyId, customerId: { not: null } },
    }),
    prisma.invoice.groupBy({
      by: ["customerId"],
      where: { companyId, customerId: { not: null }, tipo: { not: "EGRESO" } },
    }),
  ]);
  const ids = (rows: { customerId: string | null }[]) =>
    rows.map((r) => r.customerId).filter((id): id is string => id !== null);
  return proveedoresPuros(ids(conAlguna), ids(conNoEgreso));
}
