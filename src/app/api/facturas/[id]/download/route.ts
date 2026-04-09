import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

const FACTURAPI_BASE = "https://www.facturapi.io/v2";

// GET /api/facturas/[id]/download?format=pdf|xml|zip
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
  const member = await getEffectiveCompanyMembership(session.user.id, invoice.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  if (!invoice.facturapiId) {
    return NextResponse.json({ error: "Factura sin ID de Facturapi" }, { status: 422 });
  }
  if (!invoice.company.facturapiApiKey) {
    return NextResponse.json({ error: "Facturapi no configurado" }, { status: 422 });
  }

  // Proxy the download from Facturapi
  const fpRes = await fetch(
    `${FACTURAPI_BASE}/invoices/${invoice.facturapiId}/${format}`,
    {
      headers: {
        Authorization: `Bearer ${invoice.company.facturapiApiKey}`,
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
