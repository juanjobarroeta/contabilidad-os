import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyFileToken } from "@/lib/facturas/file-token";
import { getFacturapiClient } from "@/lib/facturapi";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// GET /api/facturas/[id]/file?format=xml|pdf&token=...
//
// Tokenized, session-less download for files the WhatsApp bot links to.
// Auth is the HMAC token (scoped to invoice + format, 30-min TTL), NOT a cookie.
// - XML: served from the stored rawXml (the authentic SAT CFDI).
// - PDF: only available for Facturapi-issued invoices (proxied); SAT-downloaded
//   invoices have no PDF, so we return 404 with guidance.
export async function GET(req: Request, { params }: Params) {
  const { id: invoiceId } = await params;
  const url = new URL(req.url);
  const format = url.searchParams.get("format") === "pdf" ? "pdf" : "xml";
  const token = url.searchParams.get("token") ?? "";

  if (!verifyFileToken(invoiceId, format, token)) {
    return NextResponse.json({ error: "Enlace inválido o expirado" }, { status: 403 });
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      uuid: true, rawXml: true, facturapiId: true,
      company: { select: { facturapiApiKey: true } },
    },
  });
  if (!invoice) return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });

  const filename = `CFDI_${invoice.uuid ?? invoiceId}.${format}`;

  if (format === "xml") {
    if (!invoice.rawXml) {
      return NextResponse.json(
        { error: "El XML no está disponible para esta factura (se importó antes de guardarlo)." },
        { status: 404 }
      );
    }
    return new NextResponse(invoice.rawXml, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  // PDF — only Facturapi-issued invoices have one.
  if (!invoice.facturapiId || !invoice.company.facturapiApiKey) {
    return NextResponse.json(
      { error: "No hay PDF para esta factura. Las facturas descargadas del SAT solo tienen XML." },
      { status: 404 }
    );
  }
  try {
    const fp = getFacturapiClient(invoice.company.facturapiApiKey);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream: any = await (fp as any).invoices.downloadPdf(invoice.facturapiId);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    return new NextResponse(Buffer.concat(chunks), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "No se pudo obtener el PDF de Facturapi" }, { status: 502 });
  }
}
