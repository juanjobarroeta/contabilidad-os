import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireWriter } from "@/lib/authz";

// POST /api/bancos/batch-match
// Body: { txIds: string[], invoiceId: string }
// Matches N bank transactions to ONE invoice. All txs must belong to the same
// company as the invoice, and the current user must have writer permission
// on that company.
const bodySchema = z.object({
  txIds: z.array(z.string().min(1)).min(1).max(200),
  invoiceId: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
    }
    const { txIds, invoiceId } = parsed.data;

    // Load invoice to determine company
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, companyId: true, total: true },
    });
    if (!invoice) return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });

    // Auth: writer on the invoice's company
    await requireWriter(invoice.companyId);

    // Load txs and verify they all belong to the same company as the invoice
    const txs = await prisma.bankTransaction.findMany({
      where: { id: { in: txIds } },
      select: { id: true, companyId: true, monto: true },
    });

    if (txs.length !== txIds.length) {
      return NextResponse.json({ error: "Uno o más movimientos no existen" }, { status: 404 });
    }
    const foreign = txs.find((t) => t.companyId !== invoice.companyId);
    if (foreign) {
      return NextResponse.json(
        { error: "Los movimientos pertenecen a otra empresa" },
        { status: 403 }
      );
    }

    // Update all to MATCHED pointing at the same invoice
    const result = await prisma.bankTransaction.updateMany({
      where: { id: { in: txIds } },
      data: { status: "MATCHED", invoiceId, notes: null },
    });

    // Neto firmado: un reembolso (cargo) resta, de modo que un sobrepago y su
    // devolución cubran exactamente el total en vez de sumarse.
    const sumMatched = Math.abs(txs.reduce((s, t) => s + t.monto, 0));

    return NextResponse.json({
      ok: true,
      matched: result.count,
      sumMatched,
      invoiceTotal: invoice.total,
      // Informational: tells the UI whether the linked txs fully cover the invoice
      coverage: invoice.total > 0 ? sumMatched / invoice.total : 0,
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
