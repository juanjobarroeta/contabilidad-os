import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, AuthzError, getEffectiveCompanyMembership } from "@/lib/authz";
import { decryptSecret } from "@/lib/crypto";

const FACTURAPI_BASE = "https://www.facturapi.io/v2";

// GET /api/facturas/[id]/download?format=pdf|xml|zip
// Accepts both NextAuth session (web UI) and Bearer token (cross-app callers
// like FlotaGob, which proxies this to expose the CFDI PDF/XML).
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let userId: string;
  try {
    const u = await requireUser(req);
    userId = u.id;
  } catch (e) {
    const status = e instanceof AuthzError ? e.status : 401;
    return NextResponse.json({ error: "Unauthorized" }, { status });
  }

  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const format = searchParams.get("format") ?? "pdf";

  if (!["pdf", "xml", "zip"].includes(format)) {
    return NextResponse.json({ error: "Formato inválido. Use pdf, xml o zip" }, { status: 400 });
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: { company: true },
  });

  if (!invoice) return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });

  // Verify membership
  const member = await getEffectiveCompanyMembership(userId, invoice.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  // SAT-synced invoices (Descarga Masiva) never went through Facturapi, so they
  // have no facturapiId — but we DID store the authentic CFDI. Serve that for XML
  // directly so the file is downloadable without Facturapi.
  if (format === "xml" && invoice.rawXml) {
    const uuidShort = invoice.uuid?.replace(/-/g, "").substring(0, 8) ?? id.substring(0, 8);
    return new NextResponse(invoice.rawXml, {
      status: 200,
      headers: {
        "Content-Type": "application/xml",
        "Content-Disposition": `attachment; filename="factura-${uuidShort}.xml"`,
      },
    });
  }

  if (!invoice.facturapiId) {
    // No Facturapi record (imported from the SAT). XML is only possible if rawXml
    // existed (handled above); PDF/zip can't be produced for a CFDI we didn't issue.
    const msg =
      format === "xml"
        ? "No tenemos el XML de esta factura guardado."
        : "El PDF sólo está disponible para facturas emitidas desde la app. Esta se importó del SAT — descarga el XML.";
    return NextResponse.json({ error: msg }, { status: 422 });
  }
  if (!invoice.company.facturapiApiKey) {
    return NextResponse.json({ error: "Facturapi no configurado" }, { status: 422 });
  }

  // Proxy the download from Facturapi (key is encrypted at rest — decrypt here)
  const fpRes = await fetch(
    `${FACTURAPI_BASE}/invoices/${invoice.facturapiId}/${format}`,
    {
      headers: {
        Authorization: `Bearer ${decryptSecret(invoice.company.facturapiApiKey)}`,
      },
    }
  );

  if (!fpRes.ok) {
    const text = await fpRes.text();
    return NextResponse.json(
      { error: `Error de Facturapi: ${fpRes.status} ${text}` },
      { status: fpRes.status }
    );
  }

  // Build filename
  const uuidShort = invoice.uuid?.replace(/-/g, "").substring(0, 8) ?? id.substring(0, 8);
  const filename = `factura-${uuidShort}.${format}`;

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
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
