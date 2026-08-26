// ─────────────────────────────────────────────────────────────────────────────
// El RFC ya identifica; que también nombre.
//
// BBVA en los traspasos escribe SÓLO el RFC de la contraparte («TRASPASO A
// PERIFERICA / … RFC: GEN 120904917 …»): el extractor lo saca, pero sin nombre
// la tarjeta y la mesa caen a la cadena cruda del banco. Y el nombre ES
// conocible sin pedirle nada a nadie: el RFC es la llave fiscal única, y la
// razón social de ese RFC ya vive en NUESTROS registros — el catálogo de
// clientes y los CFDIs sincronizados del SAT (los EGRESO traen la razón social
// del emisor en contraparteNombre).
//
// Regla de la casa intacta («ante la duda, no se emite»): esto sólo escribe un
// nombre cuando hay coincidencia EXACTA de RFC. Sin coincidencia, la fila se
// queda como estaba.
//
// La decisión (quién gana cuando hay varias fuentes) es pura y testeable:
// combinarNombresPorRfc. El acceso a datos vive en nombresPorRfc.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";

export interface FuenteCliente {
  rfc: string;
  razonSocial: string;
}
export interface FuenteFactura {
  contraparteRfc: string | null;
  contraparteNombre: string | null;
}

/**
 * Combina las fuentes en un mapa RFC → nombre.
 *
 * Precedencia: el catálogo de clientes gana sobre las facturas — la razón
 * social del catálogo la capturó (o confirmó) el usuario; la de la factura es
 * la que el emisor timbró, que puede venir abreviada. Entre facturas gana la
 * PRIMERA del arreglo: el caller las manda ordenadas por fecha descendente,
 * así que «primera» = la más reciente.
 */
export function combinarNombresPorRfc(
  clientes: FuenteCliente[],
  facturas: FuenteFactura[]
): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of facturas) {
    const rfc = f.contraparteRfc?.trim().toUpperCase();
    const nombre = f.contraparteNombre?.trim();
    if (rfc && nombre && !out.has(rfc)) out.set(rfc, nombre);
  }
  for (const c of clientes) {
    const rfc = c.rfc.trim().toUpperCase();
    const nombre = c.razonSocial.trim();
    if (rfc && nombre) out.set(rfc, nombre);
  }
  return out;
}

/**
 * Resuelve nombres para un lote de RFCs de UNA empresa, en dos consultas.
 *
 * Por empresa a propósito: «nuestros registros» son los de esa empresa — su
 * catálogo y sus CFDIs. No se cruzan nombres entre empresas.
 */
export async function nombresPorRfc(
  companyId: string,
  rfcs: string[]
): Promise<Map<string, string>> {
  const unicos = [...new Set(rfcs.map((r) => r.trim().toUpperCase()).filter(Boolean))];
  if (unicos.length === 0) return new Map();

  const [clientes, facturas] = await Promise.all([
    prisma.customer.findMany({
      where: { companyId, rfc: { in: unicos } },
      select: { rfc: true, razonSocial: true },
    }),
    prisma.invoice.findMany({
      where: { companyId, contraparteRfc: { in: unicos }, contraparteNombre: { not: null } },
      select: { contraparteRfc: true, contraparteNombre: true },
      orderBy: { fecha: "desc" },
      // Una fila por RFC: con el orden por fecha, distinct se queda la más
      // reciente — el nombre con el que esa contraparte factura HOY.
      distinct: ["contraparteRfc"],
    }),
  ]);

  return combinarNombresPorRfc(clientes, facturas);
}
