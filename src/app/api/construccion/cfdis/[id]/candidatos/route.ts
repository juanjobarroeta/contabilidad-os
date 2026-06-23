/**
 * GET /api/construccion/cfdis/[id]/candidatos
 *
 * Ranked match candidates for one CFDI (manual picker in the bartiz Facturas
 * inbox when the top suggestion is wrong). Same shape as the embedded
 * `suggestion` on the list.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { loadMatchPools, rankCandidates } from "@/lib/construccion/cfdi-match";

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const inv = await prisma.invoice.findUnique({
      where: { id },
      select: {
        id: true, companyId: true, tipo: true, total: true, fecha: true,
        customer: { select: { rfc: true, razonSocial: true } },
      },
    });
    if (!inv) throw new AuthzError(404, "CFDI no encontrado");
    await requireMembership(inv.companyId, undefined, req);
    await requireModule(inv.companyId, "CONSTRUCCION");

    const recibida = inv.tipo === "EGRESO";
    const supplier = recibida && inv.customer?.rfc
      ? await prisma.supplier.findFirst({
          where: { companyId: inv.companyId, rfc: inv.customer.rfc },
          select: { id: true },
        })
      : null;

    const pools = await loadMatchPools(inv.companyId);
    const candidates = rankCandidates(
      { total: inv.total, fecha: inv.fecha, recibida, emisorNombre: recibida ? inv.customer?.razonSocial ?? null : null, supplierId: supplier?.id ?? null },
      pools
    );
    return NextResponse.json(candidates);
  }
);
