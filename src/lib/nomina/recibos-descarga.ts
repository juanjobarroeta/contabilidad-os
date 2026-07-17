// ─────────────────────────────────────────────────────────────────────────────
// Descarga de recibos de nómina timbrados: resuelve, por UUID, el Invoice que
// respalda cada PayrollItem para que la UI enlace directo a
// /api/facturas/[invoiceId]/download (que ya sirve PDF/XML con autz por
// empresa). Se cruza por UUID — no por PayrollItem.facturapiId — porque los
// recibos importados del SAT son anteriores a esa convención y su vínculo
// canónico es el folio fiscal. PDF sólo existe para CFDIs emitidos vía
// Facturapi; XML existe si guardamos el rawXml (importados) o si Facturapi lo
// puede servir (emitidos).
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { normalizarUuid, variantesUuid } from "../fiscal/uuid";

export type DescargaRecibo = {
  invoiceId: string;
  pdfDisponible: boolean;
  xmlDisponible: boolean;
};

/**
 * Mapa UUID normalizado (MAYÚSCULAS) → datos de descarga, para los recibos de
 * nómina de una empresa. UUIDs nulos/vacíos se ignoran; un UUID sin Invoice
 * simplemente no aparece en el mapa (la UI muestra el recibo sin enlaces).
 */
export async function descargasPorUuid(
  companyId: string,
  cfdiUuids: Iterable<string | null | undefined>
): Promise<Map<string, DescargaRecibo>> {
  const uuids = Array.from(cfdiUuids).filter((u): u is string => !!u);
  if (uuids.length === 0) return new Map();

  const where = {
    companyId,
    tipo: "NOMINA" as const,
    uuid: { in: variantesUuid(uuids) },
  };
  // Dos consultas ligeras en vez de traer rawXml completo (10 KB+ por recibo)
  // sólo para saber si existe.
  const [invoices, conXml] = await Promise.all([
    prisma.invoice.findMany({ where, select: { id: true, uuid: true, facturapiId: true } }),
    prisma.invoice.findMany({ where: { ...where, rawXml: { not: null } }, select: { uuid: true } }),
  ]);
  const xmlSet = new Set(conXml.map((f) => normalizarUuid(f.uuid ?? "")));

  const mapa = new Map<string, DescargaRecibo>();
  for (const f of invoices) {
    if (!f.uuid) continue;
    const key = normalizarUuid(f.uuid);
    mapa.set(key, {
      invoiceId: f.id,
      pdfDisponible: !!f.facturapiId,
      xmlDisponible: xmlSet.has(key) || !!f.facturapiId,
    });
  }
  return mapa;
}
