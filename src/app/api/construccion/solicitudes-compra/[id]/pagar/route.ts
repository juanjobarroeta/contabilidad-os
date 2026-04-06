import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter, withAuthz, AuthzError } from "@/lib/authz";
import { postSolicitudCompraPaid } from "@/lib/accounting/postings";

const pagarSchema = z.object({
  bankAccountId: z.string().min(1),
  fecha: z.string().datetime().optional(),
  referencia: z.string().optional(),
});

/**
 * POST /api/construccion/solicitudes-compra/:id/pagar
 *
 * The end-to-end proof flow:
 *   APROBADA solicitud  → BankTransaction (DEBITO) + AccountingEntry pair
 *   ─────────────────────────────────────────────────────────────────────
 *     • SolicitudCompra.estado → PAGADA
 *     • SolicitudCompra.bankTransactionId → new BankTx
 *     • AccountingEntry pair: DR 5101 Costo de obra / CR 1101 Bancos
 *   All in one Prisma transaction so the loop is atomic.
 */
export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const body = await req.json().catch(() => ({}));
    const parsed = pagarSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { bankAccountId, referencia } = parsed.data;
    const fecha = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date();

    const solicitud = await prisma.solicitudCompra.findUnique({
      where: { id },
      include: {
        proyecto: { select: { codigo: true } },
        supplier: { select: { id: true } },
      },
    });
    if (!solicitud) {
      throw new AuthzError(404, "Solicitud no encontrada");
    }

    await requireWriter(solicitud.companyId);
    await requireModule(solicitud.companyId, "CONSTRUCCION");

    if (solicitud.estado !== "APROBADA") {
      return NextResponse.json(
        {
          error: `Solo se pueden pagar solicitudes APROBADAS (estado actual: ${solicitud.estado})`,
        },
        { status: 422 }
      );
    }
    if (solicitud.bankTransactionId) {
      return NextResponse.json(
        { error: "Esta solicitud ya tiene un movimiento bancario asociado" },
        { status: 409 }
      );
    }

    // Validate the bank account belongs to this company
    const bankAccount = await prisma.bankAccount.findUnique({
      where: { id: bankAccountId },
      select: { id: true, companyId: true, nombre: true },
    });
    if (!bankAccount || bankAccount.companyId !== solicitud.companyId) {
      return NextResponse.json({ error: "Cuenta bancaria inválida" }, { status: 400 });
    }

    // ── Atomic write ───────────────────────────────────────────────────────
    // 1. Create BankTransaction (DEBITO, MATCHED to this supplier)
    // 2. Post balanced ledger pair (5101 cargo / 1101 abono)
    // 3. Mutate SolicitudCompra → PAGADA + link BankTx
    const result = await prisma.$transaction(async (tx) => {
      const bankTx = await tx.bankTransaction.create({
        data: {
          companyId: solicitud.companyId,
          bankAccountId: bankAccount.id,
          fecha,
          descripcion: `Pago solicitud ${solicitud.folio}`,
          referencia: referencia ?? solicitud.folio,
          monto: -Math.abs(solicitud.total), // negative = debit
          tipo: "DEBITO",
          status: "MATCHED",
          supplierId: solicitud.supplier?.id,
          source: "UPLOAD", // generated internally; UPLOAD is the closest existing tag
          notes: `Generado por construccion: solicitud ${solicitud.id}`,
        },
      });

      await postSolicitudCompraPaid(tx, {
        companyId: solicitud.companyId,
        solicitudId: solicitud.id,
        folio: solicitud.folio,
        monto: solicitud.total,
        fecha,
        proyectoCodigo: solicitud.proyecto?.codigo,
      });

      const updated = await tx.solicitudCompra.update({
        where: { id: solicitud.id },
        data: {
          estado: "PAGADA",
          pagadaAt: fecha,
          bankTransactionId: bankTx.id,
        },
      });

      return { solicitud: updated, bankTransactionId: bankTx.id };
    });

    return NextResponse.json(result);
  }
);
