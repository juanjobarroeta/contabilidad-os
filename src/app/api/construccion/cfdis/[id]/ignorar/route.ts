/**
 * POST /api/construccion/cfdis/[id]/ignorar
 *
 * Marks a CFDI as IGNORADA (non-operational / handled elsewhere) so it leaves
 * the "por vincular" queue. Reversible by vinculando it afterwards.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const inv = await prisma.invoice.findUnique({
      where: { id },
      select: { id: true, companyId: true },
    });
    if (!inv) throw new AuthzError(404, "CFDI no encontrado");
    await requireWriter(inv.companyId, req);
    await requireModule(inv.companyId, "CONSTRUCCION");

    const data = { estado: "IGNORADA", targetTipo: null, targetId: null, targetLabel: null };
    await prisma.construccionCfdiVinculo.upsert({
      where: { invoiceId: id },
      create: { invoiceId: id, companyId: inv.companyId, ...data },
      update: data,
    });

    return NextResponse.json({ ok: true, matchEstado: "IGNORADA" });
  }
);
