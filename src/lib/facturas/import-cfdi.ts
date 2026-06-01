import { prisma } from "@/lib/prisma";
import { parseCfdiXml } from "@/lib/sat-fiel";

// ─────────────────────────────────────────────────────────────────────────────
// Record a CFDI from an uploaded file as an Invoice (NOT Facturapi-stamped —
// it's already stamped by whoever issued it; we're just registering it).
//
// XML is the source of truth: parseCfdiXml extracts exact, legally-correct
// data. A PDF is only a rendering — vision extraction of it is lossy, so the
// XML path is strongly preferred and the PDF path is marked low-confidence.
// ─────────────────────────────────────────────────────────────────────────────

const SAT_TIPO_MAP: Record<string, "INGRESO" | "EGRESO" | "NOMINA" | "PAGO" | "TRASLADO"> = {
  I: "INGRESO",
  E: "EGRESO",
  N: "NOMINA",
  P: "PAGO",
  T: "TRASLADO",
};

export interface ImportCfdiResult {
  ok: boolean;
  invoiceId?: string;
  uuid?: string | null;
  duplicate?: boolean;
  message: string;
  error?: string;
}

/**
 * Import a CFDI from its XML. Exact extraction via parseCfdiXml. Idempotent on
 * UUID. `companyRfc` decides direction (emitido vs recibido) for counterparty
 * resolution.
 */
export async function importCfdiFromXml(opts: {
  companyId: string;
  companyRfc: string;
  xml: string;
}): Promise<ImportCfdiResult> {
  const { companyId, companyRfc, xml } = opts;
  const cfdi = parseCfdiXml(xml);

  if (!cfdi.uuid || !cfdi.fecha) {
    return { ok: false, message: "El XML no parece un CFDI válido (sin UUID/fecha).", error: "invalid_cfdi" };
  }

  const existing = await prisma.invoice.findFirst({ where: { uuid: cfdi.uuid }, select: { id: true } });
  if (existing) {
    return { ok: true, invoiceId: existing.id, uuid: cfdi.uuid, duplicate: true, message: "Este CFDI ya estaba registrado." };
  }

  const isEmisor = cfdi.rfcEmisor === companyRfc;
  const tipo = (cfdi.tipo ? SAT_TIPO_MAP[cfdi.tipo] : undefined) ?? (isEmisor ? "INGRESO" : "EGRESO");

  // Counterparty (emisor for recibidos, receptor for emitidos).
  const cpRfc = isEmisor ? cfdi.rfcReceptor : cfdi.rfcEmisor;
  const cpName = isEmisor ? cfdi.nombreReceptor : cfdi.nombreEmisor;
  let customerId: string | null = null;
  if (cpRfc && cpRfc !== "XAXX010101000" && cpRfc !== "XEXX010101000") {
    const found = await prisma.customer.findFirst({ where: { companyId, rfc: cpRfc }, select: { id: true } });
    if (found) customerId = found.id;
    else if (cpName) {
      try {
        const created = await prisma.customer.create({
          data: { companyId, rfc: cpRfc, razonSocial: cpName, regimenFiscal: isEmisor ? "616" : (cfdi.regimenEmisor ?? "616") },
        });
        customerId = created.id;
      } catch { /* ignore duplicate */ }
    }
  }

  const invoice = await prisma.invoice.create({
    data: {
      companyId,
      customerId,
      tipo,
      fecha: new Date(cfdi.fecha),
      serie: cfdi.serie ?? null,
      folio: cfdi.folio ?? null,
      formaPago: cfdi.formaPago ?? "99",
      metodoPago: cfdi.metodoPago ?? "PUE",
      usoCfdi: cfdi.usoCfdi ?? "G03",
      moneda: cfdi.moneda ?? "MXN",
      subtotal: cfdi.subtotal,
      total: cfdi.total,
      totalImpuestos: cfdi.ivaTotal,
      status: "STAMPED", // it carries a UUID — already stamped by the issuer
      uuid: cfdi.uuid,
      notas: "Subido (XML)",
      items: cfdi.items.length
        ? {
            create: cfdi.items.map((it) => ({
              cantidad: it.cantidad,
              claveUnidad: it.claveUnidad,
              unidad: it.unidad,
              claveProdServ: it.claveProdServ,
              descripcion: it.descripcion,
              valorUnitario: it.valorUnitario,
              importe: it.importe,
              descuento: it.descuento,
            })),
          }
        : undefined,
      taxes: cfdi.ivaTotal > 0
        ? { create: [{ tipo: "IVA", factor: "TASA", tasa: 0.16, importe: cfdi.ivaTotal, retencion: false }] }
        : undefined,
    },
  });

  // Complemento de pago links (DoctoRelacionado), same as SAT import.
  if (tipo === "PAGO" && cfdi.doctosRelacionados?.length) {
    await prisma.pagoDoctoRelacionado.createMany({
      data: cfdi.doctosRelacionados.map((d) => ({
        pagoInvoiceId: invoice.id,
        parentUuid: d.uuid,
        impPagado: d.impPagado,
        numParcialidad: d.numParcialidad != null ? Math.trunc(d.numParcialidad) : null,
        impSaldoAnterior: d.impSaldoAnterior,
        impSaldoInsoluto: d.impSaldoInsoluto,
      })),
      skipDuplicates: true,
    });
  }

  return { ok: true, invoiceId: invoice.id, uuid: cfdi.uuid, message: "CFDI registrado." };
}
