/**
 * POST /api/construccion/cfdis/[id]/vincular
 *
 * Confirms the operational link of a CFDI to a requisición / gasto / estimación
 * / movimiento bancario. Persists a ConstruccionCfdiVinculo (estado VINCULADA)
 * with a resolved label so the inbox can show it without re-querying.
 *
 * Body: { tipo: "SOLICITUD"|"GASTO"|"ESTIMACION"|"BANK_TX", targetId }
 *
 * Cost propagation (CFDI total → linked target's project/concept) is a
 * follow-up; this persists the link.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const bodySchema = z.object({
  tipo: z.enum(["SOLICITUD", "GASTO", "ESTIMACION", "BANK_TX"]),
  targetId: z.string().min(1),
});

// Resolves a human label for the target, and verifies it belongs to the company.
async function resolveTarget(
  tipo: string,
  targetId: string,
  companyId: string
): Promise<string | null> {
  if (tipo === "SOLICITUD") {
    const s = await prisma.solicitudCompra.findFirst({
      where: { id: targetId, companyId },
      select: { folio: true, proyecto: { select: { codigo: true } } },
    });
    return s ? `${s.folio}${s.proyecto?.codigo ? ` · ${s.proyecto.codigo}` : ""}` : null;
  }
  if (tipo === "GASTO") {
    const g = await prisma.gasto.findFirst({
      where: { id: targetId, companyId },
      select: { beneficiarioNombre: true, descripcion: true },
    });
    return g ? `${g.beneficiarioNombre}${g.descripcion ? ` · ${g.descripcion}` : ""}`.slice(0, 80) : null;
  }
  if (tipo === "ESTIMACION") {
    const e = await prisma.estimacion.findFirst({
      where: { id: targetId, companyId },
      select: { numero: true, proyecto: { select: { codigo: true } } },
    });
    return e ? `EST. ${e.numero}${e.proyecto?.codigo ? ` · ${e.proyecto.codigo}` : ""}` : null;
  }
  // BANK_TX
  const bt = await prisma.bankTransaction.findFirst({
    where: { id: targetId, companyId },
    select: { referencia: true, monto: true },
  });
  return bt ? `Mov. ${bt.referencia ?? Math.abs(Number(bt.monto)).toFixed(2)}` : null;
}

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const inv = await prisma.invoice.findUnique({
      where: { id },
      select: { id: true, companyId: true, total: true },
    });
    if (!inv) throw new AuthzError(404, "CFDI no encontrado");
    await requireWriter(inv.companyId, req);
    await requireModule(inv.companyId, "CONSTRUCCION");

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { tipo, targetId } = parsed.data;

    const [label, targetTotal] = await Promise.all([
      resolveTarget(tipo, targetId, inv.companyId),
      tipo === "SOLICITUD"
        ? prisma.solicitudCompra.findFirst({ where: { id: targetId, companyId: inv.companyId }, select: { total: true } }).then((s) => s?.total ?? null)
        : Promise.resolve(null),
    ]);
    if (!label) {
      return NextResponse.json({ error: "El destino no existe o no pertenece a esta empresa" }, { status: 422 });
    }

    const data = { estado: "VINCULADA", targetTipo: tipo, targetId, targetLabel: label };
    const vinculo = await prisma.construccionCfdiVinculo.upsert({
      where: { invoiceId: id },
      create: { invoiceId: id, companyId: inv.companyId, ...data },
      update: data,
    });

    const invoiceTotal = Number(inv.total);
    const costDelta =
      targetTotal != null ? Math.round((invoiceTotal - targetTotal) * 100) / 100 : null;

    return NextResponse.json({
      ok: true,
      matchEstado: "VINCULADA",
      link: { tipo, targetId, label },
      vinculo,
      // Cost propagation signal: compare CFDI total vs target amount.
      invoiceTotal,
      targetTotal,
      costDelta,
    });
  }
);
