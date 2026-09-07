/**
 * GET   /api/salameria/pedidos/[id]
 * PATCH /api/salameria/pedidos/[id]   body: { accion: "CANCELAR" | "DATOS" | "FACTURAR", ... }
 *
 * La ficha del pedido con sus partidas, sus pagos, sus envíos y —cuando ya se
 * surtió— de qué lotes salió cada cosa.
 *
 * CANCELAR devuelve la mercancía a SU lote original (no a uno nuevo): partir la
 * trazabilidad al cancelar es cómo un lote retirado por el fabricante deja de
 * poder rastrearse. El asiento de costo no se reversa aquí — se hace con la
 * devolución, que es un hecho contable propio.
 *
 * FACTURAR sólo AMARRA el CFDI que el satélite ya timbró contra
 * `POST /api/facturas` (el endpoint canónico del hub, bearer-aware). Este
 * módulo no timbra: duplicar el timbrado es duplicar el folio fiscal.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireMembership,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";
import { devolverLotes } from "@/lib/salameria/inventario";
import { recalcularPedido } from "@/lib/salameria/pedidos";

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const pedido = await prisma.salPedido.findUnique({
      where: { id },
      include: {
        partidas: {
          include: {
            producto: {
              select: { id: true, sku: true, nombre: true, slug: true, unidad: true },
            },
          },
        },
        pagos: { orderBy: { fecha: "asc" } },
        envios: true,
        cuenta: { select: { id: true, email: true, nombre: true, telefono: true } },
        customer: { select: { id: true, razonSocial: true, rfc: true } },
        invoice: {
          select: {
            id: true,
            uuid: true,
            serie: true,
            folio: true,
            total: true,
            // Decide si hay PDF del PAC que ofrecer, o sólo la
            // representación que arma el satélite desde el XML.
            facturapiId: true,
          },
        },
      },
    });
    if (!pedido) throw new AuthzError(404, "Pedido no encontrado");

    await requireMembership(pedido.companyId, undefined, req);
    await requireModule(pedido.companyId, "SALAMERIA", req);

    const costo =
      Math.round(
        pedido.partidas.reduce(
          (a, p) => a + Number(p.cantidad) * Number(p.costoUnitario),
          0
        ) * 100
      ) / 100;
    const mercancia =
      Math.round((Number(pedido.subtotal) - Number(pedido.descuento)) * 100) / 100;

    return NextResponse.json({
      ...pedido,
      // La utilidad del pedido sólo tiene sentido cuando ya se surtió: antes,
      // el costo de las partidas es 0 y el margen saldría del 100 %.
      rentabilidad: pedido.surtidoAt
        ? {
            ingreso: mercancia,
            costo,
            utilidad: Math.round((mercancia - costo) * 100) / 100,
            margen:
              mercancia > 0
                ? Math.round(((mercancia - costo) / mercancia) * 10000) / 100
                : null,
          }
        : null,
      saldo: Math.round((Number(pedido.total) - Number(pedido.pagado)) * 100) / 100,
    });
  }
);

const patchSchema = z.discriminatedUnion("accion", [
  z.object({
    accion: z.literal("CANCELAR"),
    motivo: z.string().max(300).optional(),
  }),
  z.object({
    accion: z.literal("DATOS"),
    customerId: z.string().nullable().optional(),
    recogeEnTienda: z.boolean().optional(),
    envioNombre: z.string().max(120).nullable().optional(),
    envioTelefono: z.string().max(30).nullable().optional(),
    envioCalle: z.string().max(160).nullable().optional(),
    envioColonia: z.string().max(120).nullable().optional(),
    envioCiudad: z.string().max(120).nullable().optional(),
    envioEstado: z.string().max(80).nullable().optional(),
    envioCp: z.string().max(10).nullable().optional(),
    envioReferencia: z.string().max(300).nullable().optional(),
    descuento: z.number().min(0).optional(),
    notas: z.string().max(2000).nullable().optional(),
  }),
  z.object({
    accion: z.literal("FACTURAR"),
    invoiceId: z.string().min(1),
  }),
]);

type LoteSurtidoJson = {
  loteId: string;
  cantidad: number;
  costoUnitario: number;
};

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const pedido = await prisma.salPedido.findUnique({
      where: { id },
      include: { partidas: true },
    });
    if (!pedido) throw new AuthzError(404, "Pedido no encontrado");

    await requireWriter(pedido.companyId, req);
    await requireModule(pedido.companyId, "SALAMERIA", req);

    const datos = parsed.data;

    if (datos.accion === "FACTURAR") {
      if (pedido.invoiceId) {
        return NextResponse.json(
          { error: "El pedido ya tiene un CFDI ligado" },
          { status: 409 }
        );
      }
      // El Invoice tiene que ser de la MISMA empresa: sin esta comprobación se
      // podría colgar el CFDI de otro contribuyente a un pedido propio.
      const invoice = await prisma.invoice.findFirst({
        where: { id: datos.invoiceId, companyId: pedido.companyId },
        select: { id: true },
      });
      if (!invoice) {
        return NextResponse.json(
          { error: "La factura no existe o no es de esta empresa" },
          { status: 404 }
        );
      }
      const ligado = await prisma.salPedido.update({
        where: { id },
        data: { invoiceId: invoice.id },
      });
      return NextResponse.json(ligado);
    }

    if (datos.accion === "DATOS") {
      if (pedido.entregadoAt) {
        return NextResponse.json(
          { error: "Un pedido entregado ya no se edita" },
          { status: 409 }
        );
      }
      const { accion, ...campos } = datos;
      void accion;
      await prisma.salPedido.update({ where: { id }, data: campos });
      // Cambiar «recoge en tienda» o el descuento mueve el total: se recalcula
      // en vez de dejar que el front mande su propia aritmética.
      const recalculado = await prisma.$transaction((tx) => recalcularPedido(tx, id));
      return NextResponse.json(recalculado);
    }

    // CANCELAR
    if (pedido.estado === "CANCELADO") {
      return NextResponse.json({ error: "El pedido ya está cancelado" }, { status: 409 });
    }
    if (pedido.entregadoAt) {
      return NextResponse.json(
        { error: "Un pedido entregado se corrige con una devolución, no cancelándolo" },
        { status: 409 }
      );
    }

    const cancelado = await prisma.$transaction(async (tx) => {
      // Sólo devuelve inventario si llegó a salir. Un pedido que nunca se
      // surtió no tiene nada que devolver.
      if (pedido.surtidoAt) {
        for (const partida of pedido.partidas) {
          const lotes = (partida.lotesSurtidos ?? []) as unknown as LoteSurtidoJson[];
          if (!Array.isArray(lotes) || lotes.length === 0) continue;
          await devolverLotes(tx, {
            companyId: pedido.companyId,
            productoId: partida.productoId,
            lotes: lotes.map((l) => ({
              loteId: l.loteId,
              cantidad: Number(l.cantidad),
              costoUnitario: Number(l.costoUnitario),
            })),
            pedidoId: pedido.id,
          });
        }
      }

      return tx.salPedido.update({
        where: { id },
        data: {
          estado: "CANCELADO",
          canceladoAt: new Date(),
          motivoCancelacion: datos.motivo ?? null,
        },
      });
    });

    return NextResponse.json(cancelado);
  }
);
