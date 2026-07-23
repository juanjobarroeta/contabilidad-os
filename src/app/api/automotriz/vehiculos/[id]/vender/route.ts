/**
 * POST /api/automotriz/vehiculos/[id]/vender — el proof flow del módulo.
 *
 * DISPONIBLE/APARTADO → VENDIDO, atómico:
 *   1. ISAN (unidades NUEVO): tarifa Art. 3-I + exenciones Art. 8-II del
 *      ejercicio de la fecha de venta (src/lib/fiscal/isan.ts).
 *   2. IVA 16% sobre precio + ISAN — el ISAN forma parte de la base del IVA
 *      (Art. 12 LIVA: "…las cantidades que además se carguen o cobren al
 *      adquirente por otros impuestos…").
 *   3. Pólizas: ingreso (CxC / ingresos / IVA / ISAN) + costo de ventas
 *      (5110 / 1115) por el costo capitalizado real de la unidad.
 *   4. La comisión se registra en la unidad (resta en utilidad por VIN); su
 *      liquidación viaja a nómina en la fase de comisiones.
 *
 * El CFDI de la venta se timbra por el flujo normal de facturas del hub y se
 * liga después vía ventaInvoiceId (fase 1: prefactura → timbrado → liga).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { postVehiculoVendido } from "@/lib/accounting/postings";
import { calcularIsan } from "@/lib/fiscal/isan";

const IVA_TASA = 0.16;

const schema = z.object({
  precioVenta: z.number().positive(), // sin IVA, sin disminuir descuentos (base ISAN, Art. 2 LFISAN)
  fecha: z.string().datetime().optional(),
  clienteId: z.string().nullable().optional(),
  vendedorId: z.string().nullable().optional(),
  comisionMonto: z.number().min(0).default(0),
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
      include: { costos: { select: { tipo: true, monto: true } } },
    });
    if (!vehiculo) throw new AuthzError(404, "Unidad no encontrada");

    await requireWriter(vehiculo.companyId, req);
    await requireModule(vehiculo.companyId, "AUTOMOTRIZ", req);

    if (vehiculo.estado !== "DISPONIBLE" && vehiculo.estado !== "APARTADO") {
      return NextResponse.json(
        { error: `Sólo se venden unidades DISPONIBLES o APARTADAS (estado actual: ${vehiculo.estado})` },
        { status: 422 }
      );
    }

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

    // ISAN sólo en unidades nuevas (Art. 1 LFISAN); seminuevos no lo causan.
    const isanResultado =
      vehiculo.tipo === "NUEVO"
        ? calcularIsan(parsed.data.precioVenta, fecha.getUTCFullYear())
        : {
            base: parsed.data.precioVenta,
            impuestoTarifa: 0,
            reduccionLujo: 0,
            exencion: null,
            isan: 0,
            advertencias: [],
          };

    const iva = Math.round((parsed.data.precioVenta + isanResultado.isan) * IVA_TASA * 100) / 100;

    // Costo capitalizado real: compra + costos que entraron a 1115. El interés
    // de plan piso ya se fue a gasto (5205) — no sale del inventario, pero sí
    // resta en la utilidad por VIN.
    const costoCapitalizado =
      vehiculo.costoCompra +
      vehiculo.costos
        .filter((c) => c.tipo !== "INTERES_PISO")
        .reduce((s, c) => s + c.monto, 0);

    const updated = await prisma.$transaction(async (tx) => {
      await postVehiculoVendido(tx, {
        companyId: vehiculo.companyId,
        vehiculoId: vehiculo.id,
        vin: vehiculo.vin,
        precio: parsed.data.precioVenta,
        iva,
        isan: isanResultado.isan,
        costoInventario: costoCapitalizado,
        fecha,
      });
      return tx.vehiculo.update({
        where: { id: vehiculo.id },
        data: {
          estado: "VENDIDO",
          precioVenta: parsed.data.precioVenta,
          isan: isanResultado.isan,
          fechaVenta: fecha,
          clienteId: parsed.data.clienteId ?? vehiculo.clienteId,
          vendedorId: parsed.data.vendedorId ?? vehiculo.vendedorId,
          comisionMonto: parsed.data.comisionMonto,
        },
      });
    });

    return NextResponse.json({
      vehiculo: updated,
      desglose: {
        precio: parsed.data.precioVenta,
        isan: isanResultado.isan,
        isanImpuestoTarifa: isanResultado.impuestoTarifa,
        isanReduccionLujo: isanResultado.reduccionLujo,
        exencionIsan: isanResultado.exencion,
        iva,
        total: parsed.data.precioVenta + isanResultado.isan + iva,
        costoCapitalizado,
      },
      advertencias: isanResultado.advertencias,
    });
  }
);
