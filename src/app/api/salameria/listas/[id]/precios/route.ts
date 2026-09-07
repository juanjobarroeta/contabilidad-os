/**
 * GET /api/salameria/listas/[id]/precios
 * PUT /api/salameria/listas/[id]/precios   body: { precios: [{ productoId, precio, minimo }] }
 *
 * Los renglones de una lista. El PUT es un upsert por (producto, mínimo): se
 * mandan sólo los renglones que cambiaron, no la lista completa. Reemplazar la
 * lista entera en cada guardado —que sería más simple— convierte una pestaña
 * abierta desde ayer en un borrado masivo de precios al presionar Guardar.
 *
 * Un `precio` de 0 BORRA el renglón: es como se retira un producto de una
 * lista sin tener que exponer un DELETE aparte para la rejilla.
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

async function cargarLista(id: string) {
  const lista = await prisma.salListaPrecio.findUnique({
    where: { id },
    select: { id: true, companyId: true, nombre: true, tipo: true, descuento: true },
  });
  if (!lista) throw new AuthzError(404, "Lista no encontrada");
  return lista;
}

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const lista = await cargarLista(id);

    await requireMembership(lista.companyId, undefined, req);
    await requireModule(lista.companyId, "SALAMERIA", req);

    const precios = await prisma.salPrecio.findMany({
      where: { listaId: id },
      orderBy: [{ productoId: "asc" }, { minimo: "asc" }],
      include: {
        producto: {
          select: {
            id: true,
            sku: true,
            nombre: true,
            unidad: true,
            costoPromedio: true,
            activo: true,
          },
        },
      },
    });

    // El margen contra el costo promedio vigente es lo que hace útil esta
    // pantalla: fijar precios sin ver el costo aterrizado al lado es cómo se
    // vende por debajo del costo sin notarlo.
    const conMargen = precios.map((p) => {
      const precio = Number(p.precio);
      const costo = Number(p.producto.costoPromedio);
      return {
        ...p,
        margen: precio > 0 ? Math.round(((precio - costo) / precio) * 10000) / 100 : null,
        utilidad: Math.round((precio - costo) * 100) / 100,
      };
    });

    return NextResponse.json({ lista, precios: conMargen });
  }
);

const putSchema = z.object({
  precios: z
    .array(
      z.object({
        productoId: z.string().min(1),
        precio: z.number().min(0),
        minimo: z.number().positive().default(1),
      })
    )
    .min(1)
    .max(500),
});

export const PUT = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const parsed = putSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const lista = await cargarLista(id);
    await requireWriter(lista.companyId, req);
    await requireModule(lista.companyId, "SALAMERIA", req);

    const ids = [...new Set(parsed.data.precios.map((p) => p.productoId))];
    const propios = await prisma.salProducto.count({
      where: { id: { in: ids }, companyId: lista.companyId },
    });
    if (propios !== ids.length) {
      return NextResponse.json(
        { error: "Algún renglón apunta a un producto que no es de esta empresa" },
        { status: 400 }
      );
    }

    const resultado = await prisma.$transaction(async (tx) => {
      let guardados = 0;
      let borrados = 0;

      for (const r of parsed.data.precios) {
        const llave = {
          listaId_productoId_minimo: {
            listaId: id,
            productoId: r.productoId,
            minimo: r.minimo,
          },
        };

        if (r.precio === 0) {
          const { count } = await tx.salPrecio.deleteMany({
            where: { listaId: id, productoId: r.productoId, minimo: r.minimo },
          });
          borrados += count;
          continue;
        }

        await tx.salPrecio.upsert({
          where: llave,
          create: {
            listaId: id,
            productoId: r.productoId,
            precio: r.precio,
            minimo: r.minimo,
          },
          update: { precio: r.precio },
        });
        guardados++;
      }

      return { guardados, borrados };
    });

    return NextResponse.json(resultado);
  }
);
