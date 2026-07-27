/**
 * GET   /api/automotriz/vehiculos/[id] — detalle + rentabilidad por VIN
 * PATCH /api/automotriz/vehiculos/[id] — edición de datos no contables
 *
 * La rentabilidad se calcula, nunca se captura:
 *   utilidad = precioVenta − costoCompra − Σ costos − comisión
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const vehiculo = await prisma.vehiculo.findUnique({
      where: { id },
      include: {
        cliente: { select: { id: true, razonSocial: true, rfc: true } },
        supplier: { select: { id: true, razonSocial: true, rfc: true } },
        vendedor: { select: { id: true, nombre: true, apellidoPaterno: true } },
        compraInvoice: { select: { id: true, uuid: true, total: true, fecha: true } },
        ventaInvoice: { select: { id: true, uuid: true, total: true, fecha: true } },
        costos: { orderBy: { fecha: "asc" } },
      },
    });
    if (!vehiculo) throw new AuthzError(404, "Unidad no encontrada");

    await requireMembership(vehiculo.companyId, undefined, req);
    await requireModule(vehiculo.companyId, "AUTOMOTRIZ", req);

    const costosTotal = vehiculo.costos.reduce((s, c) => s + c.monto, 0);
    const interesPiso = vehiculo.costos
      .filter((c) => c.tipo === "INTERES_PISO")
      .reduce((s, c) => s + c.monto, 0);

    const rentabilidad =
      vehiculo.precioVenta != null
        ? {
            precioVenta: vehiculo.precioVenta,
            costoCompra: vehiculo.costoCompra,
            costosAdicionales: costosTotal,
            interesPiso,
            comision: vehiculo.comisionMonto,
            utilidad:
              vehiculo.precioVenta -
              vehiculo.costoCompra -
              costosTotal -
              vehiculo.comisionMonto,
          }
        : null;

    return NextResponse.json({ ...vehiculo, costosTotal, interesPiso, rentabilidad });
  }
);

const patchSchema = z.object({
  marca: z.string().min(1).max(60).optional(),
  modelo: z.string().min(1).max(60).optional(),
  version: z.string().max(80).nullable().optional(),
  anio: z.number().int().min(1990).max(2100).optional(),
  color: z.string().max(40).nullable().optional(),
  numeroEconomico: z.string().max(20).nullable().optional(),
  kilometraje: z.number().int().min(0).nullable().optional(),
  uso: z.enum(["VENTA", "DEMO", "CORTESIA"]).optional(),
  costoCompra: z.number().min(0).optional(),
  planPisoTasaAnual: z.number().min(0).max(2).nullable().optional(),
  planPisoInicio: z.string().datetime().nullable().optional(),
  precioLista: z.number().min(0).nullable().optional(),
  notas: z.string().max(2000).nullable().optional(),
});

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const vehiculo = await prisma.vehiculo.findUnique({
      where: { id },
      select: { id: true, companyId: true, estado: true },
    });
    if (!vehiculo) throw new AuthzError(404, "Unidad no encontrada");

    await requireWriter(vehiculo.companyId, req);
    await requireModule(vehiculo.companyId, "AUTOMOTRIZ", req);

    // Vendida/entregada: el costo ya se posteó al ledger — corregirlo aquí
    // desalinearía libro e inventario. Sólo notas/número económico.
    const soloLectura = vehiculo.estado === "VENDIDO" || vehiculo.estado === "ENTREGADO";
    if (soloLectura && (parsed.data.costoCompra !== undefined || parsed.data.precioLista !== undefined)) {
      return NextResponse.json(
        { error: `La unidad está ${vehiculo.estado}: los montos ya no se editan (usa una póliza manual)` },
        { status: 422 }
      );
    }
    // DISPONIBLE en adelante: el inventario ya se posteó con costoCompra.
    if (vehiculo.estado !== "EN_TRANSITO" && parsed.data.costoCompra !== undefined) {
      return NextResponse.json(
        { error: "El costo de compra sólo se edita EN_TRANSITO (ya se posteó el inventario)" },
        { status: 422 }
      );
    }

    const { planPisoInicio, ...rest } = parsed.data;
    const updated = await prisma.vehiculo.update({
      where: { id },
      data: {
        ...rest,
        ...(planPisoInicio !== undefined
          ? { planPisoInicio: planPisoInicio ? new Date(planPisoInicio) : null }
          : {}),
      },
    });
    return NextResponse.json(updated);
  }
);
