/**
 * GET  /api/restaurante/menu/items?companyId=... [&categoriaId=] [&activos=true]
 * POST /api/restaurante/menu/items
 *
 * Menu items with recipe + theoretical cost. Every GET row carries computed
 * fields (not persisted — always fresh against current insumo costs):
 *   costoTeorico   = Σ receta.cantidad * insumo.costoPromedio
 *   precioSinIva   = precio / (1 + ivaRate)
 *   margen         = (precioSinIva - costoTeorico) / precioSinIva
 *   foodCostPct    = costoTeorico / precioSinIva
 *
 * POST body: { companyId, nombre, precio, categoriaId?, descripcion?,
 *              estacion?, claveProdServ?, claveUnidad?,
 *              receta?: [{ insumoId, cantidad }] }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { computeCosting } from "@/lib/restaurante";

const recetaInclude = {
  categoria: { select: { id: true, nombre: true } },
  receta: {
    include: {
      insumo: {
        select: { id: true, nombre: true, unidad: true, costoPromedio: true, stock: true },
      },
    },
  },
} as const;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "RESTAURANTE", req);

  const categoriaId = searchParams.get("categoriaId");
  const activos = searchParams.get("activos") === "true";

  const [items, config] = await Promise.all([
    prisma.restMenuItem.findMany({
      where: {
        companyId,
        ...(categoriaId ? { categoriaId } : {}),
        ...(activos ? { activo: true } : {}),
      },
      include: recetaInclude,
      orderBy: [{ categoria: { orden: "asc" } }, { nombre: "asc" }],
    }),
    prisma.restauranteConfig.findUnique({ where: { companyId }, select: { ivaRate: true } }),
  ]);

  const ivaRate = config?.ivaRate ?? 0.16;
  return NextResponse.json(
    items.map((item) => ({ ...item, ...computeCosting(item, ivaRate) }))
  );
});

const recetaLineSchema = z.object({
  insumoId: z.string().min(1),
  cantidad: z.number().positive(),
});

const createSchema = z.object({
  companyId: z.string().min(1),
  nombre: z.string().min(1).max(120).transform((v) => v.trim()),
  descripcion: z.string().max(500).nullable().optional(),
  precio: z.number().positive(),
  categoriaId: z.string().nullable().optional(),
  estacion: z.enum(["COCINA", "BARRA", "POSTRES"]).default("COCINA"),
  claveProdServ: z.string().max(10).optional(),
  claveUnidad: z.string().max(5).optional(),
  receta: z.array(recetaLineSchema).default([]),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, receta, categoriaId, ...data } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "RESTAURANTE", req);

  if (categoriaId) {
    const cat = await prisma.restMenuCategoria.findUnique({
      where: { id: categoriaId },
      select: { companyId: true },
    });
    if (!cat || cat.companyId !== companyId) {
      return NextResponse.json({ error: "Categoría inválida" }, { status: 400 });
    }
  }

  if (receta.length > 0) {
    const insumoIds = [...new Set(receta.map((r) => r.insumoId))];
    if (insumoIds.length !== receta.length) {
      return NextResponse.json({ error: "Insumo repetido en la receta" }, { status: 400 });
    }
    const insumos = await prisma.restInsumo.findMany({
      where: { id: { in: insumoIds }, companyId },
      select: { id: true },
    });
    if (insumos.length !== insumoIds.length) {
      return NextResponse.json({ error: "Insumo inválido en la receta" }, { status: 400 });
    }
  }

  const existing = await prisma.restMenuItem.findUnique({
    where: { companyId_nombre: { companyId, nombre: data.nombre } },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: `Ya existe un platillo llamado «${data.nombre}»` },
      { status: 409 }
    );
  }

  const [item, config] = await Promise.all([
    prisma.restMenuItem.create({
      data: {
        companyId,
        categoriaId: categoriaId ?? null,
        ...data,
        receta: {
          create: receta.map((r) => ({ insumoId: r.insumoId, cantidad: r.cantidad })),
        },
      },
      include: recetaInclude,
    }),
    prisma.restauranteConfig.findUnique({ where: { companyId }, select: { ivaRate: true } }),
  ]);

  return NextResponse.json(
    { ...item, ...computeCosting(item, config?.ivaRate ?? 0.16) },
    { status: 201 }
  );
});
