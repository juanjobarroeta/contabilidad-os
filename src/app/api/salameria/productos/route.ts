/**
 * GET  /api/salameria/productos?companyId=... [&q=][&categoria=][&bajoMinimo=true][&publicado=true][&sinPrecio=true]
 * POST /api/salameria/productos
 *
 * El catálogo. El stock y el costo promedio que se devuelven son el ESPEJO de
 * los lotes (`SalProducto.stock`), no una agregación en vivo: listar 400 SKUs
 * agregando lotes en cada consulta es lo que hace lenta una pantalla que se
 * abre todo el día. La verdad sigue siendo el lote — ver lib/salameria/inventario.ts.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { slugUnico } from "@/lib/salameria/folio";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "SALAMERIA", req);

  const q = searchParams.get("q");
  const categoria = searchParams.get("categoria");
  const bajoMinimo = searchParams.get("bajoMinimo") === "true";
  const soloPublicados = searchParams.get("publicado") === "true";
  const sinPrecio = searchParams.get("sinPrecio") === "true";

  const productos = await prisma.salProducto.findMany({
    where: {
      companyId,
      ...(categoria ? { categoria } : {}),
      ...(soloPublicados ? { publicado: true } : {}),
      ...(q
        ? {
            OR: [
              { nombre: { contains: q, mode: "insensitive" as const } },
              { sku: { contains: q, mode: "insensitive" as const } },
              { marca: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: [{ activo: "desc" }, { nombre: "asc" }],
  });

  // «Publicado sin precio» es el hoyo silencioso de la tienda: el producto sale
  // en el catálogo y no se puede comprar. Se calcula aquí para que la lista de
  // productos pueda marcarlo sin una segunda vuelta.
  const publica = await prisma.salListaPrecio.findFirst({
    where: { companyId, publica: true, activa: true },
    select: { id: true },
  });
  const conPrecio = publica
    ? new Set(
        (
          await prisma.salPrecio.findMany({
            where: { listaId: publica.id },
            select: { productoId: true },
          })
        ).map((p) => p.productoId)
      )
    : new Set<string>();

  const conBandera = productos.map((p) => ({
    ...p,
    sinPrecio: !conPrecio.has(p.id),
    bajoMinimo: Number(p.stockMinimo) > 0 && Number(p.stock) <= Number(p.stockMinimo),
  }));

  const filtrados = conBandera.filter(
    (p) => (!bajoMinimo || p.bajoMinimo) && (!sinPrecio || p.sinPrecio)
  );

  return NextResponse.json(filtrados);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  sku: z.string().min(1).max(40).transform((v) => v.trim().toUpperCase()),
  nombre: z.string().min(1).max(160).transform((v) => v.trim()),
  marca: z.string().max(60).nullable().optional(),
  categoria: z.string().max(60).nullable().optional(),
  descripcion: z.string().max(4000).nullable().optional(),
  unidad: z.enum(["PZA", "CAJA", "KG", "G", "L", "ML"]).default("PZA"),
  presentacion: z.string().max(80).nullable().optional(),
  piezasPorCaja: z.number().int().min(0).default(0),
  pesoKg: z.number().min(0).default(0),
  claveProdServ: z.string().max(20).nullable().optional(),
  claveUnidad: z.string().max(10).nullable().optional(),
  ivaTasa: z.number().min(0).max(1).nullable().optional(),
  stockMinimo: z.number().min(0).default(0),
  publicado: z.boolean().default(false),
  destacado: z.boolean().default(false),
  preventa: z.boolean().default(false),
  fechaLlegada: z.coerce.date().nullable().optional(),
  imagenes: z.array(z.string().max(500)).max(12).default([]),
});

export const POST = withAuthz(async (req: Request) => {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, ...data } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "SALAMERIA", req);

  const existe = await prisma.salProducto.findUnique({
    where: { companyId_sku: { companyId, sku: data.sku } },
    select: { id: true },
  });
  if (existe) {
    return NextResponse.json(
      { error: `Ya existe un producto con SKU «${data.sku}»` },
      { status: 409 }
    );
  }

  // El IVA default sale de la config: la mayoría del abarrote es tasa 0 %.
  const cfg = await prisma.salConfig.findUnique({
    where: { companyId },
    select: { ivaTasaDefault: true },
  });

  const producto = await prisma.salProducto.create({
    data: {
      companyId,
      ...data,
      ivaTasa:
        data.ivaTasa !== undefined ? data.ivaTasa : Number(cfg?.ivaTasaDefault ?? 0),
      slug: await slugUnico(prisma, companyId, data.nombre),
    },
  });

  return NextResponse.json(producto, { status: 201 });
});
