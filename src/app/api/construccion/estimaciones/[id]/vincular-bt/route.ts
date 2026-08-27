/**
 * POST /api/construccion/estimaciones/[id]/vincular-bt
 *
 * Vincula el BankTransaction del cobro del cliente a la estimación.
 * Cambia estado TIMBRADA → PAGADA.
 *
 * Body: { bankTransactionId: string }
 *
 * GET /api/construccion/estimaciones/[id]/vincular-bt
 *   → lista BTs candidatos: créditos UNMATCHED en cuentas de la company,
 *     monto coincidente ±5%, fecha ±30 días desde fechaCorte.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireMembership,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

const DELTA_PCT = 0.05;
const DATE_WINDOW_DAYS = 30;

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const est = await prisma.estimacion.findUnique({
      where: { id },
      select: { id: true, companyId: true, total: true, fechaCorte: true },
    });
    if (!est) throw new AuthzError(404, "Estimación no encontrada");
    await requireMembership(est.companyId, undefined, req);
    await requireModule(est.companyId, "CONSTRUCCION");

    const minAmt = Number(est.total) * (1 - DELTA_PCT);
    const maxAmt = Number(est.total) * (1 + DELTA_PCT);
    const refDate = est.fechaCorte ?? new Date();
    const dateLow = new Date(refDate);
    dateLow.setDate(dateLow.getDate() - DATE_WINDOW_DAYS);
    const dateHigh = new Date(refDate);
    dateHigh.setDate(dateHigh.getDate() + DATE_WINDOW_DAYS);

    const candidates = await prisma.bankTransaction.findMany({
      where: {
        companyId: est.companyId,
        status: "UNMATCHED",
        tipo: "CREDITO",
        // Positive monto matching the estimación total ±DELTA_PCT
        monto: { gte: minAmt, lte: maxAmt },
        fecha: { gte: dateLow, lte: dateHigh },
      },
      select: {
        id: true,
        fecha: true,
        monto: true,
        descripcion: true,
        referencia: true,
        bankAccount: { select: { banco: true, nombre: true } },
      },
      orderBy: { fecha: "desc" },
      take: 20,
    });

    return NextResponse.json({ estimacion: { id: est.id, total: est.total }, candidates });
  }
);

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

    const est = await prisma.estimacion.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true, bankTransactionId: true },
    });
    if (!est) throw new AuthzError(404, "Estimación no encontrada");
    await requireWriter(est.companyId, req);
    await requireModule(est.companyId, "CONSTRUCCION");

    if (est.estado !== "TIMBRADA" && est.estado !== "APROBADA") {
      return NextResponse.json(
        {
          error: `No se puede vincular pago (estado: ${est.estado}). Aprueba y timbra primero.`,
        },
        { status: 422 }
      );
    }
    if (est.bankTransactionId) {
      return NextResponse.json(
        { error: "Esta estimación ya tiene un pago vinculado." },
        { status: 409 }
      );
    }

    const bt = await prisma.bankTransaction.findUnique({
      where: { id: parsed.data.bankTransactionId },
      select: { id: true, companyId: true, status: true },
    });
    if (!bt || bt.companyId !== est.companyId) {
      return NextResponse.json(
        { error: "Movimiento bancario inválido." },
        { status: 400 }
      );
    }
    if (bt.status === "MATCHED") {
      return NextResponse.json(
        { error: "Ese movimiento ya está conciliado." },
        { status: 409 }
      );
    }

    await prisma.$transaction([
      prisma.estimacion.update({
        where: { id },
        data: { bankTransactionId: bt.id, estado: "PAGADA" },
      }),
      prisma.bankTransaction.update({
        where: { id: bt.id },
        data: { status: "MATCHED" },
      }),
    ]);

    const updated = await prisma.estimacion.findUnique({ where: { id } });
    return NextResponse.json(updated);
  }
);
