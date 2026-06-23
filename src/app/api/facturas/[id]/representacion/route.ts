import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { parseRepresentacion, type Representacion } from "@/lib/facturas/representacion";
import QRCode from "qrcode";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// GET /api/facturas/[id]/representacion
//
// Devuelve la representación impresa del CFDI parseada del XML almacenado
// (rawXml). La mayoría de los CFDIs vienen de Descarga Masiva sin PDF del PAC,
// así que esta es la fuente legible. Si no hay rawXml (algunas emitidas), se
// arma un DTO parcial desde las columnas + conceptos + impuestos guardados.
export async function GET(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      customer: { select: { razonSocial: true, rfc: true } },
      company: { select: { razonSocial: true, rfc: true } },
      items: true,
      taxes: true,
    },
  });
  if (!invoice) return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, invoice.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  let rep: Representacion;
  let fromXml = false;

  if (invoice.rawXml) {
    rep = parseRepresentacion(invoice.rawXml);
    fromXml = true;
  } else {
    // Fallback sin XML: lo que tengamos en columnas + conceptos/impuestos.
    // El emisor/receptor depende de si el CFDI es de ingreso (emite la empresa)
    // o de egreso (emite el proveedor = customer).
    const esIngreso = invoice.tipo === "INGRESO" || invoice.tipo === "NOMINA";
    rep = {
      version: null,
      tipoComprobante:
        invoice.tipo === "INGRESO" ? "I" : invoice.tipo === "EGRESO" ? "E" : invoice.tipo === "NOMINA" ? "N" : invoice.tipo === "PAGO" ? "P" : invoice.tipo === "TRASLADO" ? "T" : null,
      serie: invoice.serie,
      folio: invoice.folio,
      fecha: invoice.fecha.toISOString(),
      lugarExpedicion: null,
      formaPago: invoice.formaPago,
      metodoPago: invoice.metodoPago,
      condicionesDePago: null,
      moneda: invoice.moneda,
      tipoCambio: invoice.tipoCambio,
      subtotal: invoice.subtotal,
      descuento: invoice.descuento,
      total: invoice.total,
      totalImpuestosTrasladados: null,
      totalImpuestosRetenidos: null,
      noCertificadoEmisor: null,
      emisor: {
        rfc: esIngreso ? invoice.company.rfc : invoice.customer?.rfc ?? null,
        nombre: esIngreso ? invoice.company.razonSocial : invoice.customer?.razonSocial ?? null,
        regimenFiscal: null,
      },
      receptor: {
        rfc: esIngreso ? invoice.customer?.rfc ?? null : invoice.company.rfc,
        nombre: esIngreso ? invoice.customer?.razonSocial ?? null : invoice.company.razonSocial,
        domicilioFiscal: null,
        regimenFiscal: null,
        usoCfdi: invoice.usoCfdi,
      },
      conceptos: invoice.items.map((it) => ({
        claveProdServ: it.claveProdServ,
        noIdentificacion: null,
        cantidad: it.cantidad,
        claveUnidad: it.claveUnidad,
        unidad: it.unidad,
        descripcion: it.descripcion,
        valorUnitario: it.valorUnitario,
        importe: it.importe,
        descuento: it.descuento,
        objetoImp: null,
      })),
      traslados: invoice.taxes
        .filter((t) => !t.retencion)
        .map((t) => ({ impuesto: t.tipo, tipoFactor: t.factor, tasaOCuota: t.tasa, base: t.base, importe: t.importe, retencion: false })),
      retenciones: invoice.taxes
        .filter((t) => t.retencion)
        .map((t) => ({ impuesto: t.tipo, tipoFactor: t.factor, tasaOCuota: t.tasa, base: t.base, importe: t.importe, retencion: true })),
      tfd: invoice.uuid
        ? { uuid: invoice.uuid, fechaTimbrado: null, rfcProvCertif: null, selloCFD: invoice.selloCFD, noCertificadoSAT: null, selloSAT: invoice.selloSAT, version: null }
        : null,
      cadenaOriginalTFD: invoice.cadenaOriginal,
      verificacionUrl: null,
      nomina: null,
      pagos: null,
    };
  }

  // QR con la URL de verificación del SAT (sólo si pudimos armarla del XML).
  let qrDataUrl: string | null = null;
  if (rep.verificacionUrl) {
    try {
      qrDataUrl = await QRCode.toDataURL(rep.verificacionUrl, { margin: 1, width: 220 });
    } catch {
      qrDataUrl = null;
    }
  }

  return NextResponse.json({
    representacion: rep,
    qrDataUrl,
    fromXml,
    tipoInterno: invoice.tipo,
    cancelada: invoice.status === "CANCELLED",
  });
}
