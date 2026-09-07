/**
 * GET /api/salameria/tienda/producto/[slug]?companyId=...
 *
 * La ficha pública de un producto. RUTA PÚBLICA — es la página que se comparte
 * por WhatsApp, la que indexa Google y la que abre quien nunca ha comprado.
 *
 * Devuelve los quiebres por volumen visibles («12 pz a $460 c/u») porque son un
 * argumento de venta, no un dato interno. Sigue sin devolver costo, lotes,
 * proveedor ni la existencia exacta.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { extractBearer, verifySalTiendaToken } from "@/lib/api-token";
import { tiendaPublica } from "@/lib/salameria/tienda";
import { resolverPrecio } from "@/lib/salameria/precios";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const { slug } = await ctx.params;
  const companyId = new URL(req.url).searchParams.get("companyId");

  const config = await tiendaPublica(companyId);
  if (!config || !companyId) {
    return NextResponse.json({ error: "Tienda no disponible" }, { status: 404 });
  }

  const producto = await prisma.salProducto.findFirst({
    where: { companyId, slug, activo: true, publicado: true },
    select: {
      id: true,
      sku: true,
      nombre: true,
      slug: true,
      marca: true,
      categoria: true,
      descripcion: true,
      presentacion: true,
      piezasPorCaja: true,
      imagenes: true,
      ivaTasa: true,
      preventa: true,
      fechaLlegada: true,
      stock: true,
    },
  });
  if (!producto) {
    return NextResponse.json({ error: "Producto no encontrado" }, { status: 404 });
  }

  let listaId: string | null = null;
  const token = extractBearer(req);
  if (token) {
    try {
      const payload = await verifySalTiendaToken(token);
      if (payload.companyId === companyId) {
        const cuenta = await prisma.salCuenta.findFirst({
          where: { id: payload.sub, companyId, activa: true },
          select: { listaId: true },
        });
        listaId = cuenta?.listaId ?? null;
      }
    } catch {
      // Token vencido: se ve como visitante.
    }
  }

  const [listas, renglones] = await Promise.all([
    prisma.salListaPrecio.findMany({
      where: {
        companyId,
        activa: true,
        OR: [{ publica: true }, ...(listaId ? [{ id: listaId }] : [])],
      },
      select: { id: true, descuento: true, publica: true },
    }),
    prisma.salPrecio.findMany({
      where: {
        productoId: producto.id,
        lista: {
          companyId,
          activa: true,
          OR: [{ publica: true }, ...(listaId ? [{ id: listaId }] : [])],
        },
      },
      select: { listaId: true, productoId: true, precio: true, minimo: true },
    }),
  ]);

  const publica = listas.find((l) => l.publica) ?? null;
  const cliente = listaId ? (listas.find((l) => l.id === listaId) ?? null) : null;
  const renglonesNum = renglones.map((r) => ({
    listaId: r.listaId,
    productoId: r.productoId,
    precio: Number(r.precio),
    minimo: Number(r.minimo),
  }));

  const precioPara = (cantidad: number) =>
    resolverPrecio({
      productoId: producto.id,
      cantidad,
      renglones: renglonesNum,
      listaPublica: publica
        ? { id: publica.id, descuento: Number(publica.descuento), publica: true }
        : null,
      listaCliente: cliente
        ? { id: cliente.id, descuento: Number(cliente.descuento), publica: false }
        : null,
    });

  const base = precioPara(1);
  if (base.origen === "SIN_PRECIO") {
    // Existe pero no tiene precio: para el comprador es lo mismo que no existir,
    // y enseñarlo sin precio sólo genera una pregunta a WhatsApp.
    return NextResponse.json({ error: "Producto no encontrado" }, { status: 404 });
  }

  // Los mínimos que sí bajan el precio, para pintar «12 pz a $460 c/u».
  const minimos = [
    ...new Set(
      renglonesNum
        .filter((r) => r.listaId === (cliente?.id ?? publica?.id) && r.minimo > 1)
        .map((r) => r.minimo)
    ),
  ].sort((a, b) => a - b);

  const stock = Number(producto.stock);

  return NextResponse.json({
    tienda: { nombre: config.tiendaNombre },
    mayoreo: Boolean(cliente),
    producto: {
      ...producto,
      stock: undefined,
      ivaTasa: producto.ivaTasa == null ? null : Number(producto.ivaTasa),
      disponible: producto.preventa || stock > 0,
      precio: base.precio,
      precioLista:
        base.precioLista !== null && base.precioLista > base.precio ? base.precioLista : null,
      volumen: minimos.map((m) => ({ minimo: m, precio: precioPara(m).precio })),
    },
  });
}
