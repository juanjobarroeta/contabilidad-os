/**
 * POST /api/automotriz/vehiculos/[id]/costos
 *
 * Costo unitario adicional (acondicionamiento, traslado, accesorios, interés
 * de plan piso). Crea el VehiculoCosto y su póliza en la misma transacción:
 *   INTERES_PISO → DR 5205 / CR 2104 (gasto financiero)
 *   demás        → DR 1115 / CR 2104 (capitaliza al inventario)
 * Sólo antes de la venta: al vender, el costo capitalizado sale del
 * inventario y el reporte por VIN queda congelado.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { postVehiculoCosto } from "@/lib/accounting/postings";

const schema = z.object({
  tipo: z.enum(["INTERES_PISO", "ACONDICIONAMIENTO", "TRASLADO", "ACCESORIOS", "OTRO"]),
  concepto: z.string().min(1).max(200),
  monto: z.number().positive(),
  fecha: z.string().datetime().optional(),
  invoiceId: z.string().nullable().optional(),
});

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const fecha = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date();

    const vehiculo = await prisma.vehiculo.findUnique({
      where: { id },
      select: { id: true, companyId: true, vin: true, estado: true },
    });
    if (!vehiculo) throw new AuthzError(404, "Unidad no encontrada");

    await requireWriter(vehiculo.companyId, req);
    await requireModule(vehiculo.companyId, "AUTOMOTRIZ", req);

    if (vehiculo.estado === "VENDIDO" || vehiculo.estado === "ENTREGADO" || vehiculo.estado === "CANCELADO") {
      return NextResponse.json(
        { error: `La unidad está ${vehiculo.estado}: ya no acepta costos` },
        { status: 422 }
      );
    }

    if (parsed.data.invoiceId) {
      const inv = await prisma.invoice.findUnique({
        where: { id: parsed.data.invoiceId },
        select: { companyId: true },
      });
      if (!inv || inv.companyId !== vehiculo.companyId) {
        return NextResponse.json({ error: "invoiceId inválido" }, { status: 400 });
      }
    }

    const costo = await prisma.$transaction(async (tx) => {
      const row = await tx.vehiculoCosto.create({
        data: {
          vehiculoId: vehiculo.id,
          tipo: parsed.data.tipo,
          concepto: parsed.data.concepto,
          monto: parsed.data.monto,
          fecha,
          invoiceId: parsed.data.invoiceId ?? null,
        },
      });
      await postVehiculoCosto(tx, {
        companyId: vehiculo.companyId,
        costoId: row.id,
        vin: vehiculo.vin,
        tipo: parsed.data.tipo,
        concepto: parsed.data.concepto,
        monto: parsed.data.monto,
        fecha,
      });
      return row;
    });

    return NextResponse.json(costo, { status: 201 });
  }
);
