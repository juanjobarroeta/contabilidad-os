/**
 * GET /api/automotriz/portal/facturas/[id]/download — descarga del XML del
 * CFDI (rawXml guardado por el sync). Sólo facturas del propio cliente.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, withAuthz } from "@/lib/authz";
import { requireAutoPortalAccount } from "@/lib/automotriz/portal";

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const portal = await requireAutoPortalAccount(req);
    const { id } = await ctx.params;

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      select: { companyId: true, customerId: true, rawXml: true, uuid: true, serie: true, folio: true },
    });
    if (!invoice || invoice.companyId !== portal.companyId || invoice.customerId !== portal.customerId) {
      throw new AuthzError(404, "Factura no encontrada");
    }
    if (!invoice.rawXml) {
      return NextResponse.json({ error: "Esta factura no tiene XML almacenado" }, { status: 404 });
    }

    const nombre = `${[invoice.serie, invoice.folio].filter(Boolean).join("-") || invoice.uuid || id}.xml`;
    return new NextResponse(invoice.rawXml, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="${nombre}"`,
      },
    });
  }
);
