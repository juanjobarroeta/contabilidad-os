/**
 * POST /api/construccion/proyectos/[id]/anticipo
 *
 * Records the anticipo payment from the customer. Atomically:
 *   1. Creates a BankTransaction (CREDITO, positive amount)
 *   2. Posts balanced ledger pair (DR 1101 Bancos / CR 2103 Anticipos de clientes)
 *   3. Updates Proyecto with anticipo tracking fields
 *
 * Body: {
 *   bankAccountId: string,      // the bank account the wire landed in
 *   monto: number,              // amount received (subtotal sin IVA)
 *   fecha?: string (ISO 8601),  // defaults to now
 *   referencia?: string         // bank reference number
 * }
 *
 * Guard: only allowed once per proyecto (anticipoMonto must be null).
 * To modify, the admin resets the fields manually or we add a "cancel anticipo" flow.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";
import { postAnticipoRecibido } from "@/lib/accounting/postings";

const anticipoSchema = z.object({
  bankAccountId: z.string().min(1),
  monto: z.number().positive(),
  fecha: z.string().datetime().optional(),
  referencia: z.string().optional(),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const body = await req.json().catch(() => ({}));
    const parsed = anticipoSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const fecha = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date();

    const proyecto = await prisma.proyecto.findUnique({
      where: { id },
      select: {
        id: true,
        companyId: true,
        codigo: true,
        nombre: true,
        anticipoMonto: true,
        customerId: true,
      },
    });
    if (!proyecto) {
      throw new AuthzError(404, "Proyecto no encontrado");
    }

    await requireWriter(proyecto.companyId, req);
    await requireModule(proyecto.companyId, "CONSTRUCCION");

    if (proyecto.anticipoMonto != null) {
      return NextResponse.json(
        {
          error: `Este proyecto ya tiene un anticipo registrado ($${proyecto.anticipoMonto.toFixed(2)}). Para modificarlo, contacta soporte.`,
        },
        { status: 409 }
      );
    }

    // Validate bank account belongs to same company
    const bank = await prisma.bankAccount.findUnique({
      where: { id: parsed.data.bankAccountId },
      select: { id: true, companyId: true },
    });
    if (!bank || bank.companyId !== proyecto.companyId) {
      return NextResponse.json(
        { error: "Cuenta bancaria inválida" },
        { status: 400 }
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1. Bank transaction (CREDITO = positive deposit)
      const bankTx = await tx.bankTransaction.create({
        data: {
          companyId: proyecto.companyId,
          bankAccountId: bank.id,
          fecha,
          descripcion: `Anticipo 30% — ${proyecto.codigo} ${proyecto.nombre}`,
          referencia: parsed.data.referencia ?? proyecto.codigo,
          monto: Math.abs(parsed.data.monto), // positive = credit
          tipo: "CREDITO",
          status: "MATCHED",
          source: "UPLOAD",
          notes: `Anticipo proyecto ${proyecto.id}`,
        },
      });

      // 2. Ledger pair
      await postAnticipoRecibido(tx, {
        companyId: proyecto.companyId,
        proyectoId: proyecto.id,
        proyectoCodigo: proyecto.codigo,
        monto: parsed.data.monto,
        fecha,
      });

      // 3. Update proyecto
      const updated = await tx.proyecto.update({
        where: { id: proyecto.id },
        data: {
          anticipoMonto: parsed.data.monto,
          anticipoFecha: fecha,
          anticipoBankTxId: bankTx.id,
          estado: "EN_EJECUCION", // receiving anticipo = project starts
        },
        select: {
          id: true,
          codigo: true,
          anticipoMonto: true,
          anticipoFecha: true,
          estado: true,
        },
      });

      return { proyecto: updated, bankTransactionId: bankTx.id };
    });

    return NextResponse.json(result, { status: 201 });
  }
);
