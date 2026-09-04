import type { Prisma } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Búsqueda de facturas por PALABRAS, no por frase exacta.
//
// «victor bilbao» tiene que encontrar a VICTOR JOSE BILBAO MENDIOLA. Con un
// solo `contains` de la frase completa no lo hacía: el «JOSE» de en medio
// rompía la coincidencia y la búsqueda sólo servía si uno escribía el nombre
// tal cual está en el CFDI. Aquí cada palabra se busca por separado en todos
// los campos y TODAS tienen que aparecer (en el campo que sea): así «bilbao
// 2026» o «pisa egreso» también funcionan.
//
// La lista (/api/facturas) y el Excel (/api/facturas/export) comparten esta
// función a propósito: lo que se ve es lo que se descarga.
// ─────────────────────────────────────────────────────────────────────────────

const CAMPOS = (token: string): Prisma.InvoiceWhereInput[] => [
  { uuid: { contains: token, mode: "insensitive" } },
  { serie: { contains: token, mode: "insensitive" } },
  { folio: { contains: token, mode: "insensitive" } },
  { notas: { contains: token, mode: "insensitive" } },
  { customer: { razonSocial: { contains: token, mode: "insensitive" } } },
  { customer: { rfc: { contains: token, mode: "insensitive" } } },
  // Contraparte del comprobante: hace buscables por nombre los CFDIs a
  // público en general, que no tienen Customer.
  { contraparteNombre: { contains: token, mode: "insensitive" } },
  { contraparteRfc: { contains: token, mode: "insensitive" } },
];

/** Palabras de la consulta, sin vacíos ni duplicados; máximo 8 para acotar el SQL. */
export function tokensDeBusqueda(q: string | null | undefined): string[] {
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const t of (q ?? "").split(/\s+/)) {
    const tok = t.trim();
    if (!tok) continue;
    const k = tok.toLowerCase();
    if (vistos.has(k)) continue;
    vistos.add(k);
    out.push(tok);
    if (out.length === 8) break;
  }
  return out;
}

/**
 * Cláusula Prisma de la búsqueda: un grupo OR por palabra, y todos los grupos
 * en AND. null cuando no hay nada que buscar.
 */
export function whereBusquedaFacturas(q: string | null | undefined): Prisma.InvoiceWhereInput | null {
  const tokens = tokensDeBusqueda(q);
  if (tokens.length === 0) return null;
  return { AND: tokens.map((t) => ({ OR: CAMPOS(t) })) };
}
