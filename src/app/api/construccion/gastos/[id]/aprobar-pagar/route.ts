/**
 * POST /api/construccion/gastos/[id]/aprobar-pagar
 *
 * One-click flow for Katia: "sí, páguenlo." Atomically:
 *   1. Validates the gasto is PENDIENTE (idempotent check)
 *   2. Creates a BankTransaction as a DEBITO from the gasto's
 *      bankAccountId for the gasto's importe
 *   3. Flips estado → PAGADO and stores the bankTransaction + pagadoAt
 *      + aprobadoPor / aprobadoAt audit fields
 *
 * Body (optional):
 *   {
 *     fecha?: ISO date        — when the cash left the account (default: now)
 *     referencia?: string     — SPEI id / cheque #
 *     pagoComprobanteUrl?: string  — URL of the transfer screenshot
 *   }
 *
 * Returns the updated gasto with the bankTransaction joined.
 *
 * Split flow alternative: POST /aprobar (validate, keep APROBADO) then
 * POST /pagar. For Bartiz's workflow Katia always validates + pays in
 * one step, so the one-click endpoint is what the UI actually uses.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireModule,
  requireUser,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

const bodySchema = z.object({
  // Two mutually-exclusive paths for recording the payment:
  //   A) bankTransactionId — Katia picks an existing tx Juan already
  //      imported (e.g. from Santander CSV / Belvo). System just links.
  //      Preferred — matches reconciliation with contabilidad-os.
  //   B) fecha + referencia — fallback where a new BT is created from
  //      scratch. Used when the tx isn't yet imported (cash-paid, for
  //      example).
  bankTransactionId: z.string().min(1).optional(),
  fecha: z.string().optional(),
  referencia: z.string().max(80).nullable().optional(),
  pagoComprobanteUrl: z.string().max(1000).nullable().optional(),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const gasto = await prisma.gasto.findUnique({
      where: { id },
      include: {
        proyecto: { select: { codigo: true, nombre: true } },
        bankAccount: { select: { id: true, nombre: true } },
      },
    });
    if (!gasto) throw new AuthzError(404, "Gasto no encontrado");
    await requireWriter(gasto.companyId, req);
    await requireModule(gasto.companyId, "CONSTRUCCION");

    if (gasto.estado === "PAGADO") {
      return NextResponse.json(
        { error: "El gasto ya está pagado" },
        { status: 409 }
      );
    }
    if (gasto.estado === "RECHAZADO") {
      return NextResponse.json(
        { error: "El gasto está rechazado; no se puede pagar" },
        { status: 422 }
      );
    }

    // Budget-attribution rule: every gasto must be either linked (directo)
    // or explicitly flagged as indirecto. Without this guard the $0-budget-
    // impact bug happens: Katia approves, money leaves, nothing tracked.
    const isDirecto = !!(gasto.presupuestoPartidaId || gasto.insumoId);
    const isIndirecto = gasto.indirecto === true;
    if (!isDirecto && !isIndirecto) {
      return NextResponse.json(
        {
          error:
            "No se puede aprobar: el gasto debe vincularse a una partida/insumo o marcarse como indirecto (gasolina, viáticos, etc).",
          code: "GASTO_SIN_ATRIBUCION",
        },
        { status: 422 }
      );
    }
    if (isIndirecto && !gasto.categoriaIndirecto) {
      return NextResponse.json(
        {
          error:
            "Gasto indirecto requiere una categoría (GASOLINA, VIATICOS, FLETE, etc.).",
          code: "GASTO_INDIRECTO_SIN_CATEGORIA",
        },
        { status: 422 }
      );
    }

    const user = await requireUser(req).catch(() => null);
    const userId = user?.id ?? null;

    const desc = `Gasto ${gasto.beneficiarioNombre} — ${gasto.proyecto.codigo} — ${gasto.descripcion.slice(0, 80)}`;

    const result = await prisma.$transaction(async (tx) => {
      // Double-check under transaction to avoid race
      const fresh = await tx.gasto.findUnique({
        where: { id },
        select: { estado: true, bankTransactionId: true },
      });
      if (fresh?.estado === "PAGADO" || fresh?.bankTransactionId) {
        throw new AuthzError(409, "El gasto ya fue pagado");
      }

      let bankTx;
      if (parsed.data.bankTransactionId) {
        // Link existing BankTransaction — validate same company, still
        // unmatched and not already linked to another gasto.
        const existing = await tx.bankTransaction.findUnique({
          where: { id: parsed.data.bankTransactionId },
          select: {
            id: true,
            companyId: true,
            bankAccountId: true,
            monto: true,
            status: true,
            gastoPagado: { select: { id: true } },
            rayaPagada: { select: { id: true } },
            reembolsoPagado: { select: { id: true } },
          },
        });
        if (!existing || existing.companyId !== gasto.companyId) {
          throw new AuthzError(400, "BankTransaction inválido");
        }
        if (existing.gastoPagado || existing.rayaPagada || existing.reembolsoPagado) {
          throw new AuthzError(409, "Esa transacción bancaria ya está vinculada a otro pago");
        }
        // Flip status to MATCHED so it no longer shows up in the picker
        bankTx = await tx.bankTransaction.update({
          where: { id: existing.id },
          data: { status: "MATCHED" },
        });
      } else {
        bankTx = await tx.bankTransaction.create({
          data: {
            companyId: gasto.companyId,
            bankAccountId: gasto.bankAccountId,
            fecha: parsed.data.fecha ? new Date(parsed.data.fecha) : new Date(),
            descripcion: desc,
            referencia: parsed.data.referencia ?? null,
            monto: -Math.abs(gasto.importe),
            tipo: "DEBITO",
            status: "MATCHED",
          },
        });
      }

      const updated = await tx.gasto.update({
        where: { id },
        data: {
          estado: "PAGADO",
          bankTransactionId: bankTx.id,
          pagadoAt: new Date(),
          aprobadoPor: userId ?? null,
          aprobadoAt: new Date(),
          pagoComprobanteUrl: parsed.data.pagoComprobanteUrl ?? undefined,
        },
        include: {
          bankAccount: true,
          presupuestoPartida: {
            select: {
              id: true,
              codigo: true,
              concepto: { select: { codigo: true, descripcion: true } },
            },
          },
          insumo: { select: { id: true, codigo: true, descripcion: true } },
          bankTransaction: true,
        },
      });

      return updated;
    });

    return NextResponse.json(result);
  }
);
