// ─────────────────────────────────────────────────────────────────────────────
// REP con fecha de pago anterior a la factura que liquida. Un complemento de
// pago (CFDI tipo P) no puede tener una FechaPago previa a la emisión del CFDI
// que paga — es imposible cobrar antes de facturar. Suele ser un error de
// captura del emisor (p. ej. cobró en mayo como PUE pero facturó en junio como
// PPD y puso la FechaPago en mayo). Como el IVA se causa al cobro (Art. 1-B/17
// LIVA), esa fecha equivocada desubica el IVA al mes incorrecto. La corrección
// es por sustitución (CFF 29-A). Emite UN hallazgo agregado por empresa que
// resume todos los pares REP↔factura afectados.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { normalizarUuid, variantesUuid } from "@/lib/fiscal/uuid";
import type { Hallazgo } from "./types";

export interface RepFechaAnterior {
  repId: string;
  repLabel: string;
  parentId: string;
  parentLabel: string;
  /** Fecha de pago del REP (YYYY-MM-DD). */
  fechaPago: string;
  /** Fecha de emisión de la factura que liquida (YYYY-MM-DD). */
  facturaFecha: string;
}

const etiqueta = (serie: string | null, folio: string | null, uuid?: string | null) =>
  `${serie ?? ""}${folio ?? ""}` || uuid?.slice(0, 8) || "—";

/**
 * Carga los pares REP↔factura donde la FechaPago del complemento es
 * estrictamente ANTERIOR (por día) a la emisión de la factura que paga.
 * Compara por día — un pago el mismo día de emisión (PUE) no es error.
 */
export async function cargarRepFechaPagoAnterior(companyId: string): Promise<RepFechaAnterior[]> {
  const links = await prisma.pagoDoctoRelacionado.findMany({
    where: {
      fechaPago: { not: null },
      pagoInvoice: { companyId, tipo: "PAGO", status: { not: "CANCELLED" } },
    },
    select: {
      parentUuid: true,
      fechaPago: true,
      pagoInvoice: { select: { id: true, serie: true, folio: true } },
    },
  });
  if (links.length === 0) return [];

  const parentUuids = variantesUuid(links.map((l) => l.parentUuid));
  const parents = await prisma.invoice.findMany({
    where: { companyId, uuid: { in: parentUuids }, status: { not: "CANCELLED" } },
    select: { id: true, uuid: true, fecha: true, serie: true, folio: true },
  });
  const byUuid = new Map(parents.map((p) => [normalizarUuid(p.uuid!), p]));

  const items: RepFechaAnterior[] = [];
  for (const l of links) {
    const parent = byUuid.get(normalizarUuid(l.parentUuid));
    if (!parent || !l.fechaPago) continue;
    const pagoDay = l.fechaPago.toISOString().slice(0, 10);
    const facturaDay = parent.fecha.toISOString().slice(0, 10);
    if (pagoDay < facturaDay) {
      items.push({
        repId: l.pagoInvoice.id,
        repLabel: etiqueta(l.pagoInvoice.serie, l.pagoInvoice.folio),
        parentId: parent.id,
        parentLabel: etiqueta(parent.serie, parent.folio, parent.uuid),
        fechaPago: pagoDay,
        facturaFecha: facturaDay,
      });
    }
  }
  return items;
}

/**
 * UN solo hallazgo por empresa que resume todos los pares REP↔factura con fecha
 * de pago anterior a la emisión (agregado, con `dedupeRef` estable —mismo patrón
 * que los checks de checks.ts). Sin agregar, una empresa con muchos pagos
 * parciales mal capturados generaba cientos/miles de hallazgos idénticos; el
 * agregado los junta en uno (todos los CFDIs van en `referencias`) preservando
 * posponer/resolver del usuario entre corridas.
 */
export function auditarRepFechaPagoAnterior(items: RepFechaAnterior[]): Hallazgo[] {
  if (items.length === 0) return [];
  const n = items.length;
  const sugerencia =
    "Corrige los comprobantes por sustitución: lo más común es que el cobro fue antes de emitir la factura, así que debió ser PUE con la fecha/forma de pago real. Cancela con motivo 01 (con relación) y reexpide el sustituto correcto. Verifica además en qué mes quedó el IVA: debe coincidir con la fecha de cobro real.";
  return [
    {
      checkClave: "cfdi.rep.fecha_pago_anterior_factura",
      severidad: "warn",
      mensaje:
        n === 1
          ? `El complemento de pago (REP) ${items[0].repLabel} registra una fecha de pago (${items[0].fechaPago}) ANTERIOR a la emisión de la factura ${items[0].parentLabel} (${items[0].facturaFecha}) que liquida. Una FechaPago previa a la factura es inválida y, como el IVA se causa al cobro, manda el IVA al mes equivocado.`
          : `${n} complementos de pago (REP) registran una fecha de pago ANTERIOR a la emisión de la factura que liquidan. Una FechaPago previa a la factura es inválida y, como el IVA se causa al cobro, manda el IVA a meses equivocados.`,
      referencias: items.flatMap((i) => [i.repId, i.parentId]),
      dedupeRef: "cfdi.rep.fecha_pago_anterior_factura",
      fundamento: { ley: "CFF", articulo: "29-A" },
      sugerencia,
    },
  ];
}
