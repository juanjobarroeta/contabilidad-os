/**
 * POST /api/construccion/estimaciones/[id]/vincular-invoice
 *
 * Vincula un CFDI ya emitido (Invoice) a la estimación. Cambia estado
 * APROBADA → TIMBRADA. El CFDI debe pertenecer a la misma company y no
 * estar ya ligado a otra estimación.
 *
 * Body: { invoiceId: string }
 *
 * Auto-emisión del CFDI vendrá después (necesitamos confirmar con Gerardo
 * la estructura de líneas de concepto). Por ahora Gerardo timbra desde
 * contabilidad-os y vincula el CFDI ya creado a la estimación.
 *
 * GET /api/construccion/estimaciones/[id]/vincular-invoice
 *   → lista invoices candidatos: del mismo customer, del mismo período
 *     ±15 días, importe coincidente ±5%, sin ligar a otra estimación.
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
      select: {
        id: true,
        companyId: true,
        total: true,
        fechaCorte: true,
        proyecto: { select: { customerId: true } },
      },
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

    const candidates = await prisma.invoice.findMany({
      where: {
        companyId: est.companyId,
        tipo: "INGRESO",
        status: "STAMPED",
        total: { gte: minAmt, lte: maxAmt },
        fecha: { gte: dateLow, lte: dateHigh },
        // Not already linked to another estimación
        estimacion: null,
        ...(est.proyecto?.customerId ? { customerId: est.proyecto.customerId } : {}),
      },
      select: {
        id: true,
        folio: true,
        serie: true,
        fecha: true,
        total: true,
        uuid: true,
        customer: { select: { razonSocial: true, rfc: true } },
      },
      orderBy: { fecha: "desc" },
      take: 20,
    });

    return NextResponse.json({ estimacion: { id: est.id, total: est.total }, candidates });
  }
);

const bodySchema = z.object({
  invoiceId: z.string().min(1),
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
      select: { id: true, companyId: true, estado: true, invoiceId: true },
    });
    if (!est) throw new AuthzError(404, "Estimación no encontrada");
    await requireWriter(est.companyId, req);
    await requireModule(est.companyId, "CONSTRUCCION");

    if (est.estado !== "APROBADA" && est.estado !== "TIMBRADA") {
      return NextResponse.json(
        { error: `No se puede vincular CFDI (estado: ${est.estado})` },
        { status: 422 }
      );
    }
    if (est.invoiceId) {
      return NextResponse.json(
        { error: "Esta estimación ya tiene un CFDI vinculado." },
        { status: 409 }
      );
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: parsed.data.invoiceId },
      select: { id: true, companyId: true, status: true },
    });
    if (!invoice || invoice.companyId !== est.companyId) {
      return NextResponse.json({ error: "CFDI inválido." }, { status: 400 });
    }
    if (invoice.status !== "STAMPED") {
      return NextResponse.json(
        { error: "El CFDI debe estar timbrado." },
        { status: 422 }
      );
    }

    const updated = await prisma.estimacion.update({
      where: { id },
      data: { invoiceId: invoice.id, estado: "TIMBRADA" },
    });
    return NextResponse.json(updated);
  }
);
