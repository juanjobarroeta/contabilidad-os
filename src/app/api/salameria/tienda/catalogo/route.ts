/**
 * GET /api/salameria/tienda/catalogo?companyId=... [&q=][&categoria=][&marca=]
 *
 * El escaparate. RUTA PÚBLICA A PROPÓSITO — es la portada de la tienda, y
 * pedirle sesión a quien apenas está viendo qué hay es cerrar el negocio.
 *
 * Lo que NO sale de aquí, aunque esté en la fila: costo, costos aterrizados,
 * márgenes, existencias exactas, proveedores, lotes. El catálogo devuelve
 * `disponible: boolean`, no el número: publicar «quedan 3» invita a la
 * competencia a leer el inventario completo con un script.
 *
 * Con `Authorization: Bearer <token de tienda>` los precios salen en la lista
 * del mayorista; sin él, en la pública.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { extractBearer, verifySalTiendaToken } from "@/lib/api-token";
import { tiendaPublica } from "@/lib/salameria/tienda";
import { resolverPrecio } from "@/lib/salameria/precios";

/** La lista del comprador si trae token válido de ESTA tienda; si no, null. */
async function listaDelVisitante(
  req: Request,
  companyId: string
): Promise<string | null> {
  const token = extractBearer(req);
  if (!token) return null;
  try {
    const payload = await verifySalTiendaToken(token);
    if (payload.companyId !== companyId) return null;
    const cuenta = await prisma.salCuenta.findFirst({
      where: { id: payload.sub, companyId, activa: true },
      select: { listaId: true },
    });
    return cuenta?.listaId ?? null;
  } catch {
    // Un token vencido no rompe el escaparate: se ve como visitante.
    return null;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");

  const config = await tiendaPublica(companyId);
  if (!config || !companyId) {
    return NextResponse.json({ error: "Tienda no disponible" }, { status: 404 });
  }

  const q = searchParams.get("q");
  const categoria = searchParams.get("categoria");
  const marca = searchParams.get("marca");

  const listaId = await listaDelVisitante(req, companyId);

  const productos = await prisma.salProducto.findMany({
    where: {
      companyId,
      activo: true,
      publicado: true,
      ...(categoria ? { categoria } : {}),
      ...(marca ? { marca } : {}),
      ...(q
        ? {
            OR: [
              { nombre: { contains: q, mode: "insensitive" as const } },
              { marca: { contains: q, mode: "insensitive" as const } },
              { descripcion: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: [{ destacado: "desc" }, { nombre: "asc" }],
    select: {
      id: true,
      sku: true,
      nombre: true,
      slug: true,
      marca: true,
      categoria: true,
      presentacion: true,
      imagenes: true,
      ivaTasa: true,
      preventa: true,
      fechaLlegada: true,
      destacado: true,
      stock: true,
    },
    take: 300,
  });

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
        productoId: { in: productos.map((p) => p.id) },
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

  const items = productos
    .map((p) => {
      const r = resolverPrecio({
        productoId: p.id,
        cantidad: 1,
        renglones: renglonesNum,
        listaPublica: publica
          ? { id: publica.id, descuento: Number(publica.descuento), publica: true }
          : null,
        listaCliente: cliente
          ? { id: cliente.id, descuento: Number(cliente.descuento), publica: false }
          : null,
      });
      const stock = Number(p.stock);
      return {
        id: p.id,
        sku: p.sku,
        nombre: p.nombre,
        slug: p.slug,
        marca: p.marca,
        categoria: p.categoria,
        presentacion: p.presentacion,
        imagenes: p.imagenes,
        destacado: p.destacado,
        preventa: p.preventa,
        fechaLlegada: p.fechaLlegada,
        ivaTasa: p.ivaTasa == null ? null : Number(p.ivaTasa),
        precio: r.precio,
        // Sólo cuando hay algo que tachar: un «antes» igual al «ahora» es ruido.
        precioLista: r.precioLista !== null && r.precioLista > r.precio ? r.precioLista : null,
        sinPrecio: r.origen === "SIN_PRECIO",
        // Booleano, nunca la existencia exacta.
        disponible: p.preventa || stock > 0,
      };
    })
    // Un producto sin precio no se enseña: el escaparate no puede tener un
    // hueco en el que no se pueda hacer clic.
    .filter((p) => !p.sinPrecio);

  const categorias = [...new Set(items.map((i) => i.categoria).filter(Boolean))].sort();
  const marcas = [...new Set(items.map((i) => i.marca).filter(Boolean))].sort();

  return NextResponse.json({
    tienda: {
      nombre: config.tiendaNombre,
      envioUmbral: Number(config.envioUmbral),
      envioTarifa: Number(config.envioTarifa),
      envioTarifaBase: Number(config.envioTarifaBase),
      avisoPrivacidadUrl: config.avisoPrivacidadUrl,
    },
    mayoreo: Boolean(cliente),
    categorias,
    marcas,
    productos: items,
  });
}
