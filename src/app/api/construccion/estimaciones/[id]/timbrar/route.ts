/**
 * POST /api/construccion/estimaciones/[id]/timbrar
 *
 * The money flow closer. Atomically:
 *   1. Validates the estimación is in BORRADOR with partidas filled in
 *   2. Computes deductions:
 *      - Retención de garantía (proyecto.retencionPorc% of subtotal)
 *      - Amortización de anticipo (proportional to this estimación)
 *   3. Posts ledger entries via postEstimacionTimbrada:
 *      DR 1103 CxC / CR 4101 Ingresos / CR 2102 IVA trasladado
 *   4. Posts anticipo amortization if applicable:
 *      DR 2103 Anticipos de clientes / CR 1103 CxC
 *   5. Flips estimación estado to TIMBRADA
 *   6. Updates proyecto.anticipoAmortizado running total
 *
 * NOTE: actual CFDI stamping via Facturapi is stubbed for v1 — the
 * accounting entries and state transition happen, but no real PAC call
 * is made until you connect Facturapi credentials on this company.
 * When you do, uncomment the Facturapi section and it Just Works™
 * because the Invoice model + Facturapi integration are already in
 * contabilidad-os.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";
import {
  postEstimacionTimbrada,
  postAnticipoAmortizacion,
} from "@/lib/accounting/postings";

const round2 = (n: number) => Math.round(n * 100) / 100;

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const estimacionRow = await prisma.estimacion.findUnique({
      where: { id },
      include: {
        proyecto: {
          select: {
            id: true,
            companyId: true,
            codigo: true,
            montoContratado: true,
            anticipoMonto: true,
            anticipoAmortizado: true,
            retencionPorc: true,
          },
        },
        partidas: true,
      },
    });

    if (!estimacionRow) throw new AuthzError(404, "Estimación no encontrada");
    const estimacion = {
      ...estimacionRow,
      subtotal: Number(estimacionRow.subtotal),
      iva: Number(estimacionRow.iva),
      total: Number(estimacionRow.total),
      proyecto: {
        ...estimacionRow.proyecto,
        montoContratado:
          estimacionRow.proyecto.montoContratado === null
            ? null
            : Number(estimacionRow.proyecto.montoContratado),
        anticipoMonto:
          estimacionRow.proyecto.anticipoMonto === null
            ? null
            : Number(estimacionRow.proyecto.anticipoMonto),
        anticipoAmortizado: Number(estimacionRow.proyecto.anticipoAmortizado),
      },
    };
    if (estimacion.estado !== "BORRADOR") {
      return NextResponse.json(
        { error: `Solo se pueden timbrar estimaciones en BORRADOR (estado: ${estimacion.estado})` },
        { status: 422 }
      );
    }
    if (estimacion.partidas.length === 0) {
      return NextResponse.json(
        { error: "La estimación no tiene partidas con avance. Llena el avance primero." },
        { status: 422 }
      );
    }
    if (estimacion.subtotal <= 0) {
      return NextResponse.json(
        { error: "La estimación tiene subtotal $0. Verifica las cantidades ejecutadas." },
        { status: 422 }
      );
    }

    const proy = estimacion.proyecto;
    await requireWriter(proy.companyId, req);
    await requireModule(proy.companyId, "CONSTRUCCION");

    const fecha = new Date();

    // Compute deductions
    const retencionPorc = proy.retencionPorc ?? 0;
    const retencionMonto = round2(estimacion.subtotal * (retencionPorc / 100));

    let amortizacionMonto = 0;
    if (proy.anticipoMonto && proy.montoContratado && proy.montoContratado > 0) {
      const anticipoOriginal = proy.anticipoMonto;
      const yaAmortizado = proy.anticipoAmortizado ?? 0;
      const porAmortizar = anticipoOriginal - yaAmortizado;
      if (porAmortizar > 0) {
        // Proportional: this estimación's share of the total contract
        const proporcion = estimacion.subtotal / proy.montoContratado;
        amortizacionMonto = round2(
          Math.min(anticipoOriginal * proporcion, porAmortizar)
        );
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1. Post the main estimación ledger entries
      //    DR 1103 CxC (total con IVA)
      //    CR 4101 Ingresos (subtotal)
      //    CR 2102 IVA trasladado (iva)
      await postEstimacionTimbrada(tx, {
        companyId: proy.companyId,
        estimacionId: estimacion.id,
        numero: estimacion.numero,
        proyectoCodigo: proy.codigo,
        subtotal: estimacion.subtotal,
        iva: estimacion.iva,
        fecha,
      });

      // 2. Post anticipo amortization if applicable
      if (amortizacionMonto > 0) {
        await postAnticipoAmortizacion(tx, {
          companyId: proy.companyId,
          estimacionId: estimacion.id,
          proyectoCodigo: proy.codigo,
          numero: estimacion.numero,
          monto: amortizacionMonto,
          fecha,
        });

        // Update running total on proyecto
        await tx.proyecto.update({
          where: { id: proy.id },
          data: {
            anticipoAmortizado: round2(
              (proy.anticipoAmortizado ?? 0) + amortizacionMonto
            ),
          },
        });
      }

      // 3. Flip estimación to TIMBRADA + store deduction amounts
      const updated = await tx.estimacion.update({
        where: { id: estimacion.id },
        data: {
          estado: "TIMBRADA",
          retencionGarantia: retencionMonto,
          amortizacionAnticipo: amortizacionMonto,
        },
      });

      return {
        estimacion: updated,
        deductions: {
          retencionGarantia: retencionMonto,
          amortizacionAnticipo: amortizacionMonto,
          netoACobrar: round2(
            estimacion.total - retencionMonto - amortizacionMonto
          ),
        },
      };
    });

    return NextResponse.json(result);
  }
);
