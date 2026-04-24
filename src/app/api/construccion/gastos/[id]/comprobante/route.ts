/**
 * GET /api/construccion/gastos/[id]/comprobante?type=gasto|pago
 *
 * Streams back the base64-stored comprobante file with the right
 * Content-Type. type=gasto (default) = invoice/receipt photo Rosy
 * sent; type=pago = SPEI transfer screenshot.
 *
 * We keep attachments in @db.Text so uploads work without external
 * infra (S3, Vercel Blob). Good enough for the < 2 MB typical photos.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireMembership,
  requireModule,
  withAuthz,
} from "@/lib/authz";

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const type = url.searchParams.get("type") === "pago" ? "pago" : "gasto";

    const gasto = await prisma.gasto.findUnique({
      where: { id },
      select: {
        companyId: true,
        comprobanteData: true,
        comprobanteMime: true,
        comprobanteName: true,
        pagoComprobanteData: true,
        pagoComprobanteMime: true,
        pagoComprobanteName: true,
      },
    });
    if (!gasto) throw new AuthzError(404, "Gasto no encontrado");
    await requireMembership(gasto.companyId, undefined, req);
    await requireModule(gasto.companyId, "CONSTRUCCION");

    const data =
      type === "pago" ? gasto.pagoComprobanteData : gasto.comprobanteData;
    const mime =
      type === "pago" ? gasto.pagoComprobanteMime : gasto.comprobanteMime;
    const name =
      type === "pago" ? gasto.pagoComprobanteName : gasto.comprobanteName;

    if (!data) {
      return NextResponse.json(
        { error: "Comprobante no disponible" },
        { status: 404 }
      );
    }

    const buffer = Buffer.from(data, "base64");
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": mime ?? "application/octet-stream",
        "Content-Disposition": `inline; filename="${name ?? "comprobante"}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  }
);
