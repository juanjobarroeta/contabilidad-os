import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withAuthz } from "@/lib/authz";
import { requirePortalAccount } from "@/lib/purificadora/portal";
import { decryptSecret } from "@/lib/crypto";

const FACTURAPI_BASE = "https://www.facturapi.io/v2";

// GET /api/purificadora/portal/facturas/[id]/download?format=pdf|xml|zip
// Misma mecánica que /api/facturas/[id]/download, pero autenticada con el
// token del portal y con guardia dura: la factura debe ser DE ese cliente.
export const GET = withAuthz(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requirePortalAccount(req);

    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const format = searchParams.get("format") ?? "pdf";
    if (!["pdf", "xml", "zip"].includes(format)) {
      return NextResponse.json({ error: "Formato inválido. Use pdf, xml o zip" }, { status: 400 });
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: { company: { select: { facturapiApiKey: true } } },
    });
    if (
      !invoice ||
      invoice.companyId !== ctx.companyId ||
      invoice.customerId !== ctx.customerId
    ) {
      return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });
    }

    // XML auténtico guardado (sync del SAT o timbrado propio).
    if (format === "xml" && invoice.rawXml) {
      const nombre = invoice.uuid ?? id;
      return new NextResponse(invoice.rawXml, {
        status: 200,
        headers: {
          "Content-Type": "application/xml",
          "Content-Disposition": `attachment; filename="${nombre}.xml"`,
        },
      });
    }

    if (!invoice.facturapiId) {
      const msg =
        format === "xml"
          ? "No tenemos el XML de esta factura guardado."
          : "El PDF sólo está disponible para facturas emitidas desde la app.";
      return NextResponse.json({ error: msg }, { status: 422 });
    }
    if (!invoice.company.facturapiApiKey) {
      return NextResponse.json({ error: "Descarga no disponible" }, { status: 422 });
    }

    const fpRes = await fetch(`${FACTURAPI_BASE}/invoices/${invoice.facturapiId}/${format}`, {
      headers: { Authorization: `Bearer ${decryptSecret(invoice.company.facturapiApiKey)}` },
    });
    if (!fpRes.ok) {
      return NextResponse.json({ error: "No se pudo descargar la factura" }, { status: 502 });
    }

    const contentTypes: Record<string, string> = {
      pdf: "application/pdf",
      xml: "application/xml",
      zip: "application/zip",
    };
    const body = await fpRes.arrayBuffer();
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentTypes[format],
        "Content-Disposition": `attachment; filename="${invoice.uuid ?? id}.${format}"`,
      },
    });
  }
);
