import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { ejecutarVentaUnidad, VentaError } from "@/lib/automotriz/venta";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/automotriz/pedidos/[id]/accion — transiciones del pipeline:
//   apartar  (COTIZACION → APARTADO): aparta la unidad; registra anticipo como
//            dato (el dinero real entra por conciliación bancaria — no postea).
//   facturar (COTIZACION/APARTADO → FACTURADO): ejecuta la MISMA venta que
//            /vehiculos/[id]/vender (ISAN + IVA + pólizas + comisión).
//   entregar (FACTURADO → ENTREGADO): unidad VENDIDO → ENTREGADO.
//   cancelar (COTIZACION/APARTADO → CANCELADO): des-aparta la unidad.
// ─────────────────────────────────────────────────────────────────────────────

const schema = z.object({
  accion: z.enum(["apartar", "facturar", "entregar", "cancelar"]),
  anticipo: z.number().min(0).optional(), // apartar: suma al anticipoRecibido
  fecha: z.string().datetime().optional(), // facturar
});

export const POST = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { accion } = parsed.data;

  const pedido = await prisma.pedidoVehiculo.findUnique({
    where: { id },
    include: { vehiculo: { select: { id: true, estado: true } } },
  });
  if (!pedido) throw new AuthzError(404, "Pedido no encontrado");
  await requireWriter(pedido.companyId, req);
  await requireModule(pedido.companyId, "AUTOMOTRIZ", req);

  if (accion === "apartar") {
    if (pedido.estado !== "COTIZACION") {
      return NextResponse.json({ error: `Sólo una COTIZACION se aparta (estado: ${pedido.estado})` }, { status: 422 });
    }
    if (pedido.vehiculo.estado !== "DISPONIBLE") {
      return NextResponse.json({ error: `La unidad no está DISPONIBLE (${pedido.vehiculo.estado})` }, { status: 422 });
    }
    const updated = await prisma.$transaction(async (tx) => {
      await tx.vehiculo.update({ where: { id: pedido.vehiculoId }, data: { estado: "APARTADO" } });
      return tx.pedidoVehiculo.update({
        where: { id },
        data: {
          estado: "APARTADO",
          apartadoAt: new Date(),
          ...(parsed.data.anticipo ? { anticipoRecibido: pedido.anticipoRecibido + parsed.data.anticipo } : {}),
        },
      });
    });
    return NextResponse.json(updated);
  }

  if (accion === "facturar") {
    if (pedido.estado !== "COTIZACION" && pedido.estado !== "APARTADO") {
      return NextResponse.json({ error: `Un pedido ${pedido.estado} no se factura` }, { status: 422 });
    }
    try {
      const venta = await ejecutarVentaUnidad({
        vehiculoId: pedido.vehiculoId,
        precioVenta: pedido.precio,
        fecha: parsed.data.fecha ? new Date(parsed.data.fecha) : new Date(),
        clienteId: pedido.clienteId,
        vendedorId: pedido.vendedorId,
        comisionMonto: null, // regla de la empresa
      });
      const updated = await prisma.pedidoVehiculo.update({
        where: { id },
        data: { estado: "FACTURADO", facturadoAt: new Date() },
      });
      return NextResponse.json({ pedido: updated, ...venta });
    } catch (e) {
      if (e instanceof VentaError) return NextResponse.json({ error: e.message }, { status: e.status });
      throw e;
    }
  }

  if (accion === "entregar") {
    if (pedido.estado !== "FACTURADO") {
      return NextResponse.json({ error: `Sólo un pedido FACTURADO se entrega (${pedido.estado})` }, { status: 422 });
    }
    const updated = await prisma.$transaction(async (tx) => {
      if (pedido.vehiculo.estado === "VENDIDO") {
        await tx.vehiculo.update({ where: { id: pedido.vehiculoId }, data: { estado: "ENTREGADO" } });
      }
      return tx.pedidoVehiculo.update({
        where: { id },
        data: { estado: "ENTREGADO", entregadoAt: new Date() },
      });
    });
    return NextResponse.json(updated);
  }

  // cancelar
  if (pedido.estado !== "COTIZACION" && pedido.estado !== "APARTADO") {
    return NextResponse.json({ error: `Un pedido ${pedido.estado} no se cancela desde aquí` }, { status: 422 });
  }
  const updated = await prisma.$transaction(async (tx) => {
    if (pedido.estado === "APARTADO" && pedido.vehiculo.estado === "APARTADO") {
      await tx.vehiculo.update({ where: { id: pedido.vehiculoId }, data: { estado: "DISPONIBLE" } });
    }
    return tx.pedidoVehiculo.update({ where: { id }, data: { estado: "CANCELADO" } });
  });
  return NextResponse.json(updated);
});
