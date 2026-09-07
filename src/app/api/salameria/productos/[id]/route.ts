/**
 * GET   /api/salameria/productos/[id]
 * PATCH /api/salameria/productos/[id]
 *
 * La ficha: el producto con sus lotes vivos y sus precios en cada lista.
 *
 * `stock` y `costoPromedio` NO se editan aquí. En un almacén por lotes, mover
 * el saldo a mano deja un número que ningún lote respalda: la corrección de
 * inventario es una baja de lote (POST …/almacen/lotes/[id]/baja) o una
 * entrada, y las dos dejan rastro en el kardex.
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

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const producto = await prisma.salProducto.findUnique({
      where: { id },
      include: {
        lotes: {
          where: { cantidad: { gt: 0 } },
          orderBy: [{ caducidad: "asc" }, { createdAt: "asc" }],
          include: {
            importacion: { select: { id: true, folio: true, pedimento: true } },
            compra: { select: { id: true, folio: true } },
          },
        },
        precios: { include: { lista: { select: { id: true, nombre: true, tipo: true } } } },
      },
    });
    if (!producto) throw new AuthzError(404, "Producto no encontrado");

    await requireMembership(producto.companyId, undefined, req);
    await requireModule(producto.companyId, "SALAMERIA", req);

    return NextResponse.json(producto);
  }
);

const patchSchema = z.object({
  nombre: z.string().min(1).max(160).transform((v) => v.trim()).optional(),
  marca: z.string().max(60).nullable().optional(),
  categoria: z.string().max(60).nullable().optional(),
  descripcion: z.string().max(4000).nullable().optional(),
  unidad: z.enum(["PZA", "CAJA", "KG", "G", "L", "ML"]).optional(),
  presentacion: z.string().max(80).nullable().optional(),
  piezasPorCaja: z.number().int().min(0).optional(),
  pesoKg: z.number().min(0).optional(),
  claveProdServ: z.string().max(20).nullable().optional(),
  claveUnidad: z.string().max(10).nullable().optional(),
  ivaTasa: z.number().min(0).max(1).nullable().optional(),
  stockMinimo: z.number().min(0).optional(),
  activo: z.boolean().optional(),
  publicado: z.boolean().optional(),
  destacado: z.boolean().optional(),
  preventa: z.boolean().optional(),
  fechaLlegada: z.coerce.date().nullable().optional(),
  imagenes: z.array(z.string().max(500)).max(12).optional(),
});

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const producto = await prisma.salProducto.findUnique({
      where: { id },
      select: { id: true, companyId: true },
    });
    if (!producto) throw new AuthzError(404, "Producto no encontrado");

    await requireWriter(producto.companyId, req);
    await requireModule(producto.companyId, "SALAMERIA", req);

    // El slug NO se regenera al renombrar: es la URL que ya circula por
    // WhatsApp y en los pedidos viejos. Cambiarla rompe enlaces vivos.
    const actualizado = await prisma.salProducto.update({
      where: { id },
      data: parsed.data,
    });

    return NextResponse.json(actualizado);
  }
);
