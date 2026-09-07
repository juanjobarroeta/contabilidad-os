/**
 * GET /api/salameria/tienda/pedidos [?id=...]
 *
 * «Mis pedidos» del comprador. Acotado al `cuentaId` del token — el filtro por
 * cuenta va en el WHERE, nunca como un parámetro que el cliente pueda cambiar.
 *
 * Un pedido de preventa enseña lo que ya pagó y lo que falta, y la fecha de
 * llegada prometida: es la pregunta que ese cliente hace por WhatsApp cada
 * semana hasta que llega el contenedor.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withAuthz } from "@/lib/authz";
import { requireSalCuenta } from "@/lib/salameria/tienda";

export const GET = withAuthz(async (req: Request) => {
  const ctx = await requireSalCuenta(req);
  const id = new URL(req.url).searchParams.get("id");

  const pedidos = await prisma.salPedido.findMany({
    where: {
      // Estas dos condiciones son la seguridad de la ruta: el id de la query
      // sólo ACOTA dentro de lo que ya es de esta cuenta.
      companyId: ctx.companyId,
      cuentaId: ctx.cuentaId,
      estado: { not: "CARRITO" },
      ...(id ? { id } : {}),
    },
    orderBy: { fecha: "desc" },
    take: id ? 1 : 50,
    select: {
      id: true,
      folio: true,
      estado: true,
      fecha: true,
      subtotal: true,
      descuento: true,
      envio: true,
      iva: true,
      total: true,
      pagado: true,
      esPreventa: true,
      recogeEnTienda: true,
      envioNombre: true,
      envioCalle: true,
      envioColonia: true,
      envioCiudad: true,
      envioEstado: true,
      envioCp: true,
      pagadoAt: true,
      surtidoAt: true,
      entregadoAt: true,
      canceladoAt: true,
      invoice: { select: { uuid: true, serie: true, folio: true } },
      envios: {
        select: { paqueteria: true, guia: true, estado: true, enviadoAt: true, entregadoAt: true },
      },
      partidas: {
        select: {
          cantidad: true,
          precio: true,
          importe: true,
          nombreCongelado: true,
          esPreventa: true,
          producto: {
            select: {
              slug: true,
              nombre: true,
              imagenes: true,
              presentacion: true,
              fechaLlegada: true,
            },
          },
        },
      },
    },
  });

  if (id && pedidos.length === 0) {
    return NextResponse.json({ error: "Pedido no encontrado" }, { status: 404 });
  }

  const conSaldo = pedidos.map((p) => ({
    ...p,
    saldo: Math.round((Number(p.total) - Number(p.pagado)) * 100) / 100,
    // La fecha prometida más lejana de sus partidas de preventa: es la que
    // manda para todo el pedido, porque se envía completo.
    llegadaEstimada: p.esPreventa
      ? p.partidas
          .filter((x) => x.esPreventa && x.producto.fechaLlegada)
          .map((x) => x.producto.fechaLlegada!)
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null
      : null,
  }));

  return NextResponse.json(id ? conSaldo[0] : conSaldo);
});
