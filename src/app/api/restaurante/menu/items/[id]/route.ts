/**
 * GET   /api/restaurante/menu/items/[id]
 * PATCH /api/restaurante/menu/items/[id]
 *
 * PATCH accepts scalar fields plus an optional full `receta` replacement
 * (delete + recreate — recipes are small). `disponible` is the day-to-day
 * "86" toggle; `activo` removes the item from the catalog.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
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

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const raw = await prisma.restMenuItem.findUnique({ where: { id }, include: recetaInclude });
    if (!raw) throw new AuthzError(404, "Platillo no encontrado");
    const item = {
      ...raw,
      precio: Number(raw.precio),
      receta: raw.receta.map((r) => ({
        ...r,
        cantidad: Number(r.cantidad),
        insumo: { ...r.insumo, costoPromedio: Number(r.insumo.costoPromedio) },
      })),
    };

    await requireMembership(item.companyId, undefined, req);
    await requireModule(item.companyId, "RESTAURANTE", req);

    const config = await prisma.restauranteConfig.findUnique({
      where: { companyId: item.companyId },
      select: { ivaRate: true },
    });
    return NextResponse.json({ ...item, ...computeCosting(item, Number(config?.ivaRate ?? 0.16)) });
  }
);

const recetaLineSchema = z.object({
  insumoId: z.string().min(1),
  cantidad: z.number().positive(),
});

const patchSchema = z.object({
  nombre: z.string().min(1).max(120).transform((v) => v.trim()).optional(),
  descripcion: z.string().max(500).nullable().optional(),
  precio: z.number().positive().optional(),
  categoriaId: z.string().nullable().optional(),
  estacion: z.enum(["COCINA", "BARRA", "POSTRES"]).optional(),
  claveProdServ: z.string().max(10).optional(),
  claveUnidad: z.string().max(5).optional(),
  activo: z.boolean().optional(),
  disponible: z.boolean().optional(),
  receta: z.array(recetaLineSchema).optional(),
});

export const PATCH = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const item = await prisma.restMenuItem.findUnique({
      where: { id },
      select: { id: true, companyId: true },
    });
    if (!item) throw new AuthzError(404, "Platillo no encontrado");

    await requireWriter(item.companyId, req);
    await requireModule(item.companyId, "RESTAURANTE", req);

    const { receta, categoriaId, ...data } = parsed.data;

    if (data.nombre) {
      const dup = await prisma.restMenuItem.findUnique({
        where: { companyId_nombre: { companyId: item.companyId, nombre: data.nombre } },
        select: { id: true },
      });
      if (dup && dup.id !== id) {
        return NextResponse.json(
          { error: `Ya existe un platillo llamado «${data.nombre}»` },
          { status: 409 }
        );
      }
    }

    if (categoriaId) {
      const cat = await prisma.restMenuCategoria.findUnique({
        where: { id: categoriaId },
        select: { companyId: true },
      });
      if (!cat || cat.companyId !== item.companyId) {
        return NextResponse.json({ error: "Categoría inválida" }, { status: 400 });
      }
    }

    if (receta && receta.length > 0) {
      const insumoIds = [...new Set(receta.map((r) => r.insumoId))];
      if (insumoIds.length !== receta.length) {
        return NextResponse.json({ error: "Insumo repetido en la receta" }, { status: 400 });
      }
      const insumos = await prisma.restInsumo.findMany({
        where: { id: { in: insumoIds }, companyId: item.companyId },
        select: { id: true },
      });
      if (insumos.length !== insumoIds.length) {
        return NextResponse.json({ error: "Insumo inválido en la receta" }, { status: 400 });
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (receta) {
        await tx.restReceta.deleteMany({ where: { menuItemId: id } });
        if (receta.length > 0) {
          await tx.restReceta.createMany({
            data: receta.map((r) => ({ menuItemId: id, insumoId: r.insumoId, cantidad: r.cantidad })),
          });
        }
      }
      return tx.restMenuItem.update({
        where: { id },
        data: {
          ...data,
          ...(categoriaId !== undefined ? { categoriaId } : {}),
        },
        include: recetaInclude,
      }).then((it) => ({
        ...it,
        precio: Number(it.precio),
        receta: it.receta.map((r) => ({
          ...r,
          cantidad: Number(r.cantidad),
          insumo: { ...r.insumo, costoPromedio: Number(r.insumo.costoPromedio) },
        })),
      }));
    });

    const config = await prisma.restauranteConfig.findUnique({
      where: { companyId: item.companyId },
      select: { ivaRate: true },
    });
    return NextResponse.json({ ...updated, ...computeCosting(updated, Number(config?.ivaRate ?? 0.16)) });
  }
);
