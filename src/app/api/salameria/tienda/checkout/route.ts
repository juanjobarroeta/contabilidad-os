/**
 * POST /api/salameria/tienda/checkout
 * body: { envio: {...} | recogeEnTienda, factura?: { rfc, razonSocial, regimenFiscal, codigoPostal } }
 *
 * Convierte el carrito en pedido. Es el punto donde el escaparate se vuelve una
 * obligación, así que aquí sí se bloquea:
 *
 *   • Un producto que se quedó sin stock entre que se agregó y que se paga
 *     detiene el checkout con el detalle de qué falta. Dejarlo pasar es vender
 *     algo que no existe y descubrirlo al surtir, con el cliente esperando.
 *   • Un producto que perdió su precio detiene el checkout.
 *   • Los precios se RE-RESUELVEN y se congelan aquí. El precio válido es el
 *     del momento de comprar, no el de cuando el carrito se abrió hace tres
 *     días — y a partir de este instante ya no cambia.
 *
 * NO COBRA. Deja el pedido en PENDIENTE_PAGO; el cobro entra por
 * POST /api/salameria/pedidos/[id]/pagar (mostrador) o por el webhook de la
 * pasarela con su `referenciaExterna` idempotente. Un checkout que cobrara
 * tendría que ser también el que concilia, y son dos responsabilidades.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { withAuthz } from "@/lib/authz";
import { requireSalCuenta } from "@/lib/salameria/tienda";
import { anticipoRequerido, recalcularPedido, resolverPartidas } from "@/lib/salameria/pedidos";

const schema = z.object({
  recogeEnTienda: z.boolean().default(false),
  envioNombre: z.string().max(120).nullable().optional(),
  envioTelefono: z.string().max(30).nullable().optional(),
  envioCalle: z.string().max(160).nullable().optional(),
  envioColonia: z.string().max(120).nullable().optional(),
  envioCiudad: z.string().max(120).nullable().optional(),
  envioEstado: z.string().max(80).nullable().optional(),
  envioCp: z.string().max(10).nullable().optional(),
  envioReferencia: z.string().max(300).nullable().optional(),
  notas: z.string().max(1000).nullable().optional(),
  /** Datos fiscales si quiere factura. Se crea/reutiliza el Customer del hub. */
  factura: z
    .object({
      rfc: z.string().min(12).max(13).transform((s) => s.toUpperCase().trim()),
      razonSocial: z.string().min(1).max(200).transform((s) => s.trim()),
      regimenFiscal: z.string().min(3).max(3),
      codigoPostal: z.string().min(5).max(5),
      email: z.string().email().max(160).optional(),
    })
    .nullable()
    .optional(),
});

export const POST = withAuthz(async (req: Request) => {
  const ctx = await requireSalCuenta(req);
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { factura, ...datos } = parsed.data;

  const carrito = await prisma.salPedido.findFirst({
    where: { companyId: ctx.companyId, cuentaId: ctx.cuentaId, estado: "CARRITO" },
    include: { partidas: true },
    orderBy: { createdAt: "desc" },
  });
  if (!carrito || carrito.partidas.length === 0) {
    return NextResponse.json({ error: "El carrito está vacío" }, { status: 400 });
  }

  if (!datos.recogeEnTienda) {
    const faltan = (
      ["envioNombre", "envioCalle", "envioCiudad", "envioCp"] as const
    ).filter((k) => !datos[k]);
    if (faltan.length) {
      return NextResponse.json(
        { error: "Faltan datos de envío", campos: faltan },
        { status: 400 }
      );
    }
  }

  // Re-resolver contra el estado de HOY: es el chequeo que impide vender lo que
  // se acabó mientras el carrito estaba abierto.
  const resueltas = await resolverPartidas(prisma, {
    companyId: ctx.companyId,
    listaId: ctx.listaId,
    partidas: carrito.partidas.map((p) => ({
      productoId: p.productoId,
      cantidad: Number(p.cantidad),
    })),
  });

  const problemas = resueltas.filter((r) => r.problema !== null);
  if (problemas.length) {
    return NextResponse.json(
      {
        error: "Algunos productos ya no están disponibles",
        partidas: problemas.map((r) => ({
          productoId: r.productoId,
          nombre: r.nombre,
          problema: r.problema,
          disponible: r.disponible,
        })),
      },
      { status: 409 }
    );
  }

  // El Customer es canónico del hub: se reutiliza por RFC en vez de duplicar el
  // directorio fiscal. Si la cuenta ya tenía uno, se respeta.
  let customerId = ctx.customerId;
  if (factura) {
    const existente = await prisma.customer.findFirst({
      where: { companyId: ctx.companyId, rfc: factura.rfc },
      select: { id: true },
    });
    customerId =
      existente?.id ??
      (
        await prisma.customer.create({
          data: {
            companyId: ctx.companyId,
            rfc: factura.rfc,
            razonSocial: factura.razonSocial,
            regimenFiscal: factura.regimenFiscal,
            codigoPostal: factura.codigoPostal,
            email: factura.email ?? ctx.email,
          },
          select: { id: true },
        })
      ).id;

    // Se recuerda en la cuenta para que la próxima compra ya no lo pida.
    if (!ctx.customerId) {
      await prisma.salCuenta.update({
        where: { id: ctx.cuentaId },
        data: { customerId },
      });
    }
  }

  const cfg = await prisma.salConfig.findUnique({
    where: { companyId: ctx.companyId },
    select: { anticipoPreventa: true },
  });

  const pedido = await prisma.$transaction(async (tx) => {
    // Congela los precios de hoy en las partidas.
    for (const r of resueltas) {
      await tx.salPedidoPartida.updateMany({
        where: { pedidoId: carrito.id, productoId: r.productoId },
        data: {
          precio: r.precio,
          ivaTasa: r.ivaTasa,
          importe: r.importe,
          nombreCongelado: r.nombre,
          esPreventa: r.esPreventa,
        },
      });
    }

    await tx.salPedido.update({
      where: { id: carrito.id },
      data: {
        ...datos,
        estado: "PENDIENTE_PAGO",
        customerId,
        fecha: new Date(),
      },
    });

    return recalcularPedido(tx, carrito.id);
  });

  const anticipo = anticipoRequerido({
    total: Number(pedido.total),
    esPreventa: pedido.esPreventa,
    porcentaje: Number(cfg?.anticipoPreventa ?? 0),
  });

  return NextResponse.json(
    {
      pedido,
      // Lo que hay que cobrar AHORA: el total, o sólo el anticipo si es preventa.
      aCobrar: anticipo > 0 ? anticipo : Number(pedido.total),
      esAnticipo: anticipo > 0,
    },
    { status: 201 }
  );
});
