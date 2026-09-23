// ─────────────────────────────────────────────────────────────────────────────
// CUÁNTO DE UNA FACTURA PPD YA ESTÁ AMPARADO POR COMPLEMENTOS DE PAGO.
//
// La respuesta salía de una convención frágil: al timbrar un REP desde la app
// se guardaba el id de la factura padre en `Invoice.notas`, y el detector
// buscaba por ahí. Un REP que NO timbró esta app —el del portal del SAT, el del
// PAC anterior, el que timbró el contador de antes— llega por la sincronización
// con `notas = "SAT — emitidos"`, así que era invisible: su factura seguía
// apareciendo «sin complemento» para siempre. Visto en CENTRO DE
// PROCEDIMIENTOS: 27 complementos por emitir.
//
// El enlace de verdad ya estaba en la base y lo dice el propio esquema: el nodo
// <pago:DoctoRelacionado> del XML se guarda en PagoDoctoRelacionado con el UUID
// del documento pagado, «para poder decir con EXACTITUD si el pago de una PPD
// ya se complementó». Eso es lo que se lee aquí, venga el REP de donde venga.
//
// Y se suma `impPagado` —lo que el complemento dice haber pagado de ESA
// factura— en vez del total del REP: un solo complemento puede amparar cinco
// facturas, y cargarle el total a cada una las daba por saldadas de más.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { normalizarUuid, variantesUuid } from "../fiscal/uuid";

type Db = PrismaClient | Prisma.TransactionClient;

/** UUID normalizado de la factura padre → importe ya amparado por REPs vigentes. */
export async function amparadoPorReps(
  db: Db,
  companyId: string,
  uuids: Iterable<string | null | undefined>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const lista = variantesUuid(uuids);
  if (lista.length === 0) return out;

  const links = await db.pagoDoctoRelacionado.findMany({
    where: {
      parentUuid: { in: lista },
      // Un REP cancelado no ampara nada. La cancelación SOLICITADA sí ampara:
      // el CFDI sigue vigente hasta que el SAT la resuelve.
      pagoInvoice: { companyId, tipo: "PAGO", status: { not: "CANCELLED" }, sustituidoPorUuid: null },
    },
    select: { parentUuid: true, impPagado: true },
  });
  for (const l of links) {
    const k = normalizarUuid(l.parentUuid);
    out.set(k, (out.get(k) ?? 0) + Number(l.impPagado ?? 0));
  }
  return out;
}

/** Los REPs que amparan cada factura padre, para enseñarlos con su folio. */
export async function repsPorFactura(
  db: Db,
  companyId: string,
  uuids: Iterable<string | null | undefined>,
): Promise<Map<string, Array<{ id: string; uuid: string | null; total: number; fecha: Date }>>> {
  const out = new Map<string, Array<{ id: string; uuid: string | null; total: number; fecha: Date }>>();
  const lista = variantesUuid(uuids);
  if (lista.length === 0) return out;

  const links = await db.pagoDoctoRelacionado.findMany({
    where: {
      parentUuid: { in: lista },
      pagoInvoice: { companyId, tipo: "PAGO", status: { not: "CANCELLED" }, sustituidoPorUuid: null },
    },
    select: {
      parentUuid: true,
      impPagado: true,
      pagoInvoice: { select: { id: true, uuid: true, fecha: true } },
    },
  });
  for (const l of links) {
    const k = normalizarUuid(l.parentUuid);
    const lista2 = out.get(k) ?? [];
    // El importe que se enseña es lo que el REP ampara de ESTA factura.
    lista2.push({ id: l.pagoInvoice.id, uuid: l.pagoInvoice.uuid, total: Number(l.impPagado ?? 0), fecha: l.pagoInvoice.fecha });
    out.set(k, lista2);
  }
  return out;
}
