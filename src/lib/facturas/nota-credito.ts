// ─────────────────────────────────────────────────────────────────────────────
// Nota de crédito (CFDI de egreso, tipo "E") — EMISIÓN.
//
// Devoluciones, descuentos y bonificaciones sobre una factura de ingreso YA
// timbrada, sin cancelarla: se emite un CFDI tipo "E" relacionado al padre con
// la clave SAT "01". Persistencia: tipo "INGRESO" (convención del código: la
// dirección — nosotros lo emitimos) + tipoSat "E", que el motor fiscal netea
// con signo NEGATIVO (reduce ingresos e IVA trasladado del periodo de emisión).
// El padre y la nota quedan ambos vigentes — esto NO es una cancelación.
//
// NOTA OPERATIVA: el nombre exacto del campo de CFDI relacionados de Facturapi
// (related_documents / relationship / documents con UUIDs) debe verificarse en
// sandbox antes de habilitar en producción; si difiere, Facturapi rechaza la
// emisión con error visible (nunca timbra mal en silencio).
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { getPacProvider } from "@/lib/pac";
import { recordTimbrado } from "@/lib/costos/record";
import { checkStampReadiness } from "@/lib/facturas/stamp";
import { round2 } from "@/lib/complementos-rep";

export interface NotaCreditoInput {
  companyId: string;
  /** Factura de INGRESO timbrada a la que se aplica la nota. */
  parentInvoiceId: string;
  /** Descripción del concepto (p.ej. "Devolución parcial de servicios"). */
  descripcion: string;
  /** Monto BASE (sin IVA) de la nota. */
  montoBase: number;
  /** Tasa de IVA (default: 0.16; usar 0 si el padre no trasladó IVA). */
  ivaTasa?: number;
  /** Forma de pago SAT de la restitución (default "99" por definir). */
  formaPago?: string;
}

export type NotaCreditoResult =
  | { ok: true; invoiceId: string; uuid: string; total: number }
  | { ok: false; status: number; error: string };

export async function emitirNotaCredito(input: NotaCreditoInput): Promise<NotaCreditoResult> {
  const parent = await prisma.invoice.findFirst({
    where: { id: input.parentInvoiceId, companyId: input.companyId, tipo: "INGRESO", status: "STAMPED" },
    select: {
      id: true, uuid: true, subtotal: true, total: true, customerId: true, usoCfdi: true,
      customer: { select: { facturapiId: true, razonSocial: true } },
      // Notas previas sobre este padre, para no acreditar más que el subtotal.
    },
  });
  if (!parent) return { ok: false, status: 404, error: "Factura de ingreso timbrada no encontrada." };
  if (!parent.uuid) return { ok: false, status: 400, error: "La factura no tiene folio fiscal." };
  if (!parent.customerId) return { ok: false, status: 422, error: "La factura no tiene cliente registrado." };

  const readiness = await checkStampReadiness(input.companyId, parent.customerId);
  if (readiness && !readiness.ok) return { ok: false, status: readiness.status, error: readiness.error };

  const montoBase = round2(input.montoBase);
  if (!(montoBase > 0)) return { ok: false, status: 400, error: "El monto de la nota debe ser mayor a cero." };

  // Tope: la suma de notas emitidas sobre el padre no puede exceder su subtotal.
  const previas = await prisma.invoice.aggregate({
    where: { companyId: input.companyId, tipoSat: "E", status: "STAMPED", cfdiRelacionadoUuid: parent.uuid },
    _sum: { subtotal: true },
  });
  const acreditado = previas._sum.subtotal ?? 0;
  if (montoBase > round2(parent.subtotal - acreditado) + 0.01) {
    return {
      ok: false,
      status: 422,
      error: `La nota (${montoBase.toFixed(2)}) excede lo acreditable de la factura (subtotal ${parent.subtotal.toFixed(2)}, ya acreditado ${acreditado.toFixed(2)}).`,
    };
  }

  const ivaTasa = input.ivaTasa ?? 0.16;
  const company = await prisma.company.findUnique({
    where: { id: input.companyId },
    select: { facturapiApiKey: true },
  });

  const out = await getPacProvider().createCfdi(
    { apiKey: company!.facturapiApiKey!, companyId: input.companyId, actor: "nota-credito" },
    {
    type: "E",
    relations: { relationship: "01", documents: [parent.uuid] },
    customerRef: parent.customer!.facturapiId!,
    paymentForm: input.formaPago ?? "99",
    paymentMethod: "PUE",
    // G02 = devoluciones, descuentos o bonificaciones.
    use: "G02",
    items: [
      {
        quantity: 1,
        product: {
          description: input.descripcion,
          product_key: "84111506",
          unit_key: "ACT",
          price: montoBase,
          tax_included: false,
          taxes: ivaTasa > 0 ? [{ type: "IVA", rate: ivaTasa, factor: "Tasa" }] : [],
        },
      },
    ],
  });
  if (!out.ok) return { ok: false, status: out.status, error: out.message };

  void recordTimbrado("factura", 1, { companyId: input.companyId, subtipo: "nota_credito" });

  const iva = round2(montoBase * ivaTasa);
  const rep = await prisma.invoice.create({
    data: {
      companyId: input.companyId,
      customerId: parent.customerId,
      // Dirección (la emitimos) + tipoSat "E": el motor fiscal la netea negativa.
      tipo: "INGRESO",
      tipoSat: "E",
      cfdiRelacionadoUuid: parent.uuid,
      tipoRelacion: "01",
      fecha: new Date(),
      formaPago: input.formaPago ?? "99",
      metodoPago: "PUE",
      usoCfdi: "G02",
      subtotal: montoBase,
      totalImpuestos: iva,
      total: round2(montoBase + iva),
      status: "STAMPED",
      uuid: out.data.uuid?.toUpperCase() ?? null,
      facturapiId: out.data.pacId ?? null,
      taxes: ivaTasa > 0 ? { create: [{ tipo: "IVA", factor: "TASA", tasa: ivaTasa, base: montoBase, importe: iva, retencion: false }] } : undefined,
    },
    select: { id: true, uuid: true, total: true },
  });

  return { ok: true, invoiceId: rep.id, uuid: rep.uuid ?? "", total: rep.total };
}
