/**
 * POST /api/automotriz/vehiculos/[id]/vender — el proof flow del módulo.
 *
 * DISPONIBLE/APARTADO → VENDIDO, atómico. El cálculo (ISAN + IVA + pólizas +
 * comisión por regla de la empresa) vive en lib/automotriz/venta.ts — la misma
 * ruta de código que usa POST /pedidos/[id]/facturar.
 *
 * El CFDI de la venta se timbra por el flujo normal de facturas del hub y se
 * liga después vía ventaInvoiceId (fase 1: prefactura → timbrado → liga).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { ejecutarVentaUnidad, VentaError } from "@/lib/automotriz/venta";

const schema = z.object({
  precioVenta: z.number().positive(), // sin IVA, sin disminuir descuentos (base ISAN, Art. 2 LFISAN)
  fecha: z.string().datetime().optional(),
  clienteId: z.string().nullable().optional(),
  vendedorId: z.string().nullable().optional(),
  // Sin monto explícito, se aplica la regla de AutomotrizConfig (si existe).
  comisionMonto: z.number().min(0).optional(),
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
      select: { companyId: true },
    });
    if (!vehiculo) throw new AuthzError(404, "Unidad no encontrada");

    await requireWriter(vehiculo.companyId, req);
    await requireModule(vehiculo.companyId, "AUTOMOTRIZ", req);

    if (parsed.data.clienteId) {
      const cli = await prisma.customer.findUnique({
        where: { id: parsed.data.clienteId },
        select: { companyId: true },
      });
      if (!cli || cli.companyId !== vehiculo.companyId) {
        return NextResponse.json({ error: "clienteId inválido" }, { status: 400 });
      }
    }
    if (parsed.data.vendedorId) {
      const emp = await prisma.employee.findUnique({
        where: { id: parsed.data.vendedorId },
        select: { companyId: true },
      });
      if (!emp || emp.companyId !== vehiculo.companyId) {
        return NextResponse.json({ error: "vendedorId inválido" }, { status: 400 });
      }
    }

    try {
      const r = await ejecutarVentaUnidad({
        vehiculoId: id,
        precioVenta: parsed.data.precioVenta,
        fecha,
        clienteId: parsed.data.clienteId,
        vendedorId: parsed.data.vendedorId,
        comisionMonto: parsed.data.comisionMonto ?? null,
      });
      return NextResponse.json(r);
    } catch (e) {
      if (e instanceof VentaError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      throw e;
    }
  }
);
