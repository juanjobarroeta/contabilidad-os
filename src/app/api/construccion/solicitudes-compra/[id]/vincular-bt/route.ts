/**
 * POST /api/construccion/solicitudes-compra/[id]/vincular-bt
 *
 * Body: { bankTransactionId: string }
 *
 * Links an existing UNMATCHED BankTransaction to an APROBADA requisición.
 * This is the "the SPEI was imported from the CSV first; now I'm telling
 * you which OC it paid" flow — the alternative to /pagar (which creates a
 * synthetic BT). Use this when the bank statement is the source of truth.
 *
 * Side effects:
 *   - SolicitudCompra → estado=PAGADA, pagadaAt=now(), bankTransactionId set
 *   - BankTransaction → status=MATCHED, supplierId set if missing
 *
 * Note: we do NOT post the accounting pair here. /pagar handles the new-BT
 * case where there's no posting yet. For an imported BT, the assumption is
 * the bank-statement import has already created its own ledger entries (or
 * will, when the imported batch is posted). Posting again would double-book.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";

const bodySchema = z.object({
  bankTransactionId: z.string().min(1),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const sol = await prisma.solicitudCompra.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true, supplierId: true, bankTransactionId: true },
    });
    if (!sol) throw new AuthzError(404, "Solicitud no encontrada");
    await requireWriter(sol.companyId, req);
    await requireModule(sol.companyId, "CONSTRUCCION");

    if (sol.bankTransactionId) {
      return NextResponse.json(
        { error: "Esta requisición ya tiene un movimiento bancario vinculado" },
        { status: 409 }
      );
    }
    if (sol.estado !== "APROBADA") {
      return NextResponse.json(
        { error: `La requisición debe estar APROBADA (estado actual: ${sol.estado})` },
        { status: 422 }
      );
    }

    const bt = await prisma.bankTransaction.findUnique({
      where: { id: parsed.data.bankTransactionId },
      select: { id: true, companyId: true, status: true, supplierId: true },
    });
    if (!bt || bt.companyId !== sol.companyId) {
      return NextResponse.json({ error: "Movimiento bancario inválido" }, { status: 400 });
    }
    if (bt.status === "MATCHED") {
      return NextResponse.json(
        { error: "Ese movimiento ya está conciliado" },
        { status: 409 }
      );
    }

    const result = await prisma.$transaction([
      prisma.solicitudCompra.update({
        where: { id: sol.id },
        data: {
          estado: "PAGADA",
          pagadaAt: new Date(),
          bankTransactionId: bt.id,
        },
      }),
      prisma.bankTransaction.update({
        where: { id: bt.id },
        data: {
          status: "MATCHED",
          // Backfill supplierId if missing — the OC is the authority.
          ...(sol.supplierId && !bt.supplierId ? { supplierId: sol.supplierId } : {}),
        },
      }),
    ]);

    return NextResponse.json({ solicitud: result[0], bankTransactionId: bt.id });
  }
);
