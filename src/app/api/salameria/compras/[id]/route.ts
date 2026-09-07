/**
 * GET   /api/salameria/compras/[id]
 * PATCH /api/salameria/compras/[id]   body: { accion: "RECIBIR" | "PAGAR" | "CANCELAR", ... }
 *
 * El ciclo de la compra nacional. Las dos transiciones que mueven el libro:
 *
 *   RECIBIR → crea un lote por partida, escribe el kardex y postea
 *             DR 1108 Almacén + DR 1118 IVA / CR 2104 Acreedores.
 *   PAGAR   → DR 2104 / CR 1100 Caja ó 1101 Bancos.
 *
 * El ESTADO es la idempotencia: recibir dos veces responde 409 en vez de
 * duplicar el inventario. Es la misma regla que en toda la guía de satélites —
 * la máquina de estados de la fila fuente es lo que impide el doble posteo.
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
import { entrarLote } from "@/lib/salameria/inventario";
import {
  postCompraSalameriaPagada,
  postCompraSalameriaRecibida,
} from "@/lib/accounting/postings";

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const compra = await prisma.salCompra.findUnique({
      where: { id },
      include: {
        supplier: { select: { id: true, razonSocial: true, rfc: true } },
        items: {
          include: {
            producto: { select: { id: true, sku: true, nombre: true, unidad: true } },
          },
        },
        lotes: { select: { id: true, codigo: true, caducidad: true, cantidad: true } },
      },
    });
    if (!compra) throw new AuthzError(404, "Compra no encontrada");

    // Leer es de cualquier miembro; accionar (PATCH) pide requireWriter.
    await requireMembership(compra.companyId, undefined, req);
    await requireModule(compra.companyId, "SALAMERIA", req);

    return NextResponse.json(compra);
  }
);

const patchSchema = z.discriminatedUnion("accion", [
  z.object({
    accion: z.literal("RECIBIR"),
    fecha: z.coerce.date().optional(),
  }),
  z.object({
    accion: z.literal("PAGAR"),
    formaPago: z.enum(["EFECTIVO", "TRANSFERENCIA", "TARJETA"]),
    bankAccountId: z.string().nullable().optional(),
    fecha: z.coerce.date().optional(),
  }),
  z.object({
    accion: z.literal("CANCELAR"),
  }),
]);

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const compra = await prisma.salCompra.findUnique({
      where: { id },
      include: {
        supplier: { select: { razonSocial: true } },
        items: true,
      },
    });
    if (!compra) throw new AuthzError(404, "Compra no encontrada");

    await requireWriter(compra.companyId, req);
    await requireModule(compra.companyId, "SALAMERIA", req);

    const datos = parsed.data;
    const fecha = "fecha" in datos ? (datos.fecha ?? new Date()) : new Date();

    if (datos.accion === "CANCELAR") {
      if (compra.estado === "RECIBIDA" || compra.estado === "PAGADA") {
        return NextResponse.json(
          {
            error:
              "La mercancía ya entró al almacén: cancela con una devolución, no borrando la compra",
          },
          { status: 409 }
        );
      }
      const cancelada = await prisma.salCompra.update({
        where: { id },
        data: { estado: "CANCELADA" },
      });
      return NextResponse.json(cancelada);
    }

    if (datos.accion === "RECIBIR") {
      if (compra.estado !== "BORRADOR" && compra.estado !== "ORDENADA") {
        return NextResponse.json(
          { error: `Una compra ${compra.estado} ya no se recibe` },
          { status: 409 }
        );
      }

      const actualizada = await prisma.$transaction(async (tx) => {
        const vigente = await tx.salCompra.findUnique({
          where: { id },
          select: { estado: true },
        });
        if (vigente?.estado !== "BORRADOR" && vigente?.estado !== "ORDENADA") {
          throw new AuthzError(409, "Esta compra ya fue recibida");
        }

        for (const item of compra.items) {
          await entrarLote(tx, {
            companyId: compra.companyId,
            productoId: item.productoId,
            cantidad: Number(item.cantidad),
            costoUnitario: Number(item.costoUnitario),
            codigo: item.loteCodigo,
            caducidad: item.caducidad,
            compraId: compra.id,
            tipo: "ENTRADA_COMPRA",
            referencia: compra.id,
            referenciaTipo: "SAL_COMPRA",
            fecha,
          });
        }

        await postCompraSalameriaRecibida(tx, {
          companyId: compra.companyId,
          compraId: compra.id,
          folio: compra.folio,
          subtotal: Number(compra.subtotal),
          iva: Number(compra.iva),
          fecha,
          proveedorNombre: compra.supplier?.razonSocial,
        });

        return tx.salCompra.update({
          where: { id },
          data: { estado: "RECIBIDA", recibidaAt: fecha },
        });
      });

      return NextResponse.json(actualizada);
    }

    // PAGAR
    if (compra.estado !== "RECIBIDA") {
      return NextResponse.json(
        {
          error:
            compra.estado === "PAGADA"
              ? "Esta compra ya está pagada"
              : "Recibe la compra antes de pagarla (el pasivo nace al recibir)",
        },
        { status: 409 }
      );
    }

    const total = Number(compra.subtotal) + Number(compra.iva);

    const pagada = await prisma.$transaction(async (tx) => {
      const vigente = await tx.salCompra.findUnique({
        where: { id },
        select: { estado: true },
      });
      if (vigente?.estado !== "RECIBIDA") {
        throw new AuthzError(409, "Esta compra ya está pagada");
      }

      await postCompraSalameriaPagada(tx, {
        companyId: compra.companyId,
        compraId: compra.id,
        folio: compra.folio,
        total,
        formaPago: datos.formaPago,
        fecha,
        proveedorNombre: compra.supplier?.razonSocial,
      });

      return tx.salCompra.update({
        where: { id },
        data: {
          estado: "PAGADA",
          pagadaAt: fecha,
          formaPago: datos.formaPago,
          bankAccountId: datos.bankAccountId ?? null,
        },
      });
    });

    return NextResponse.json(pagada);
  }
);
