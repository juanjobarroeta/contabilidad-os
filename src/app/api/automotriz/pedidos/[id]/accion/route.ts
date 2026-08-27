import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { ejecutarVentaUnidad, VentaError } from "@/lib/automotriz/venta";
import { unidadVigentePorVin } from "@/lib/automotriz/unidad-vigente";

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
  // facturar con toma a cuenta: datos del usado que entra a inventario como
  // SEMINUEVO con costoCompra = tomaACuentaMonto (compra a persona física
  // exenta de IVA — ver docs/AUTOMOTRIZ-SEMINUEVOS.md). Opcional: sin VIN la
  // unidad se da de alta después desde Inventario.
  toma: z
    .object({
      vin: z.string().length(17),
      marca: z.string().min(1).max(60),
      modelo: z.string().min(1).max(60),
      anio: z.number().int().min(1980).max(new Date().getFullYear() + 2),
      kilometraje: z.number().int().min(0).nullable().optional(),
      color: z.string().max(40).nullable().optional(),
    })
    .optional(),
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
          ...(parsed.data.anticipo ? { anticipoRecibido: Number(pedido.anticipoRecibido) + parsed.data.anticipo } : {}),
        },
      });
    });
    return NextResponse.json(updated);
  }

  if (accion === "facturar") {
    if (pedido.estado !== "COTIZACION" && pedido.estado !== "APARTADO") {
      return NextResponse.json({ error: `Un pedido ${pedido.estado} no se factura` }, { status: 422 });
    }

    // La toma a cuenta se valida ANTES de ejecutar la venta (la venta postea
    // pólizas — no queremos revertirla por un VIN duplicado).
    const toma = parsed.data.toma;
    let tomaVin: string | null = null;
    if (toma) {
      if (!pedido.tomaACuentaMonto || Number(pedido.tomaACuentaMonto) <= 0) {
        return NextResponse.json({ error: "El pedido no tiene toma a cuenta registrada" }, { status: 422 });
      }
      tomaVin = toma.vin.trim().toUpperCase();
      const existente = await unidadVigentePorVin(prisma, pedido.companyId, tomaVin, { id: true });
      if (existente) {
        return NextResponse.json({ error: `El VIN ${tomaVin} ya está en el inventario` }, { status: 422 });
      }
    }

    try {
      const fechaVenta = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date();
      const venta = await ejecutarVentaUnidad({
        vehiculoId: pedido.vehiculoId,
        precioVenta: Number(pedido.precio),
        fecha: fechaVenta,
        clienteId: pedido.clienteId,
        vendedorId: pedido.vendedorId,
        comisionMonto: null, // regla de la empresa
      });

      // Alta del seminuevo tomado: entra DISPONIBLE con costo = valor de toma
      // (compra exenta de IVA, sin CFDI — patrón de unidad sin compraInvoiceId,
      // el costo queda editable). El IVA sobre margen de su reventa está
      // documentado pero NO activo (docs/AUTOMOTRIZ-SEMINUEVOS.md §3.2).
      let tomaVehiculoId: string | null = null;
      if (toma && tomaVin) {
        const seminuevo = await prisma.vehiculo.create({
          data: {
            companyId: pedido.companyId,
            vin: tomaVin,
            marca: toma.marca.trim().toUpperCase(),
            modelo: toma.modelo.trim().toUpperCase(),
            anio: toma.anio,
            color: toma.color?.trim() || null,
            kilometraje: toma.kilometraje ?? null,
            tipo: "SEMINUEVO",
            estado: "DISPONIBLE",
            uso: "VENTA",
            costoCompra: pedido.tomaACuentaMonto ?? 0,
            fechaCompra: fechaVenta,
            autoCreado: false,
            notas: `Toma a cuenta del pedido (unidad ${pedido.vehiculoId})${pedido.tomaACuentaDesc ? `: ${pedido.tomaACuentaDesc}` : ""}`,
          },
          select: { id: true },
        });
        tomaVehiculoId = seminuevo.id;
      }

      const updated = await prisma.pedidoVehiculo.update({
        where: { id },
        data: { estado: "FACTURADO", facturadoAt: new Date() },
      });
      return NextResponse.json({ pedido: updated, tomaVehiculoId, ...venta });
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
