// ─────────────────────────────────────────────────────────────────────────────
// Persistencia de la identidad fiscal de un cliente tomada de un CFDI.
//
// La decisión de QUÉ escribir es pura y vive en identidad-receptor.ts; aquí
// sólo está el toque a la base. La comparten los tres caminos que dan de alta
// clientes desde CFDIs (sat-sync, import-cfdi, upload-cfdi) y el backfill.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import {
  identidadDesdeCfdi,
  parcheCliente,
  type ReceptorCfdi,
} from "./identidad-receptor";

/**
 * Rellena CP y régimen de un cliente EXISTENTE con lo que trae el CFDI.
 * No-op cuando no hay nada que aportar o cuando el cliente ya tiene el dato
 * capturado. Best-effort: nunca tumba la importación de un comprobante.
 */
export async function parchearClienteDesdeCfdi(
  customerId: string,
  cfdi: ReceptorCfdi,
  esEmitida: boolean
): Promise<void> {
  const identidad = identidadDesdeCfdi(cfdi, esEmitida);
  if (!identidad.codigoPostal && !identidad.regimenFiscal) return;

  try {
    const actual = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { codigoPostal: true, regimenFiscal: true },
    });
    if (!actual) return;

    const parche = parcheCliente(actual, identidad);
    if (Object.keys(parche).length === 0) return;

    await prisma.customer.update({ where: { id: customerId }, data: parche });
  } catch (e) {
    // Un cliente sin parchear no vale abortar la importación del CFDI.
    console.error(
      "[cliente-fiscal] no se pudo parchear:",
      customerId,
      e instanceof Error ? e.message : e
    );
  }
}
