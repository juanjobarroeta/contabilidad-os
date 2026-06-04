import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyDraftToken } from "@/lib/facturas/file-token";
import { getFacturapiClient } from "@/lib/facturapi";

export const runtime = "nodejs";

type Params = { params: Promise<{ draftId: string }> };

// GET /api/facturas/draft/[draftId]/pdf?companyId=...&token=...
//
// Streams the BORRADOR (prefactura) PDF of a Facturapi draft so the WhatsApp
// bot can let the user validate the SAT classification before timbrar. A draft
// has no local Invoice row yet, so auth is the HMAC token (scoped to
// company + draftId, 30-min TTL) — NOT a cookie. Inline so it previews in chat.
export async function GET(req: Request, { params }: Params) {
  const { draftId } = await params;
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId") ?? "";
  const token = url.searchParams.get("token") ?? "";

  if (!companyId || !verifyDraftToken(companyId, draftId, token)) {
    return NextResponse.json({ error: "Enlace inválido o expirado" }, { status: 403 });
  }

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { facturapiApiKey: true },
  });
  if (!company?.facturapiApiKey) {
    return NextResponse.json({ error: "Empresa no encontrada o sin Facturapi" }, { status: 404 });
  }

  try {
    const fp = getFacturapiClient(company.facturapiApiKey);
    const stream = await fp.invoices.downloadPdf(draftId);
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    return new NextResponse(Buffer.concat(chunks), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="prefactura_${draftId}.pdf"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "No se pudo obtener la prefactura de Facturapi" }, { status: 502 });
  }
}
