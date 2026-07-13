/**
 * GET  /api/restaurante/insumos?companyId=... [&q=...] [&lowStock=true]
 * POST /api/restaurante/insumos
 *
 * Insumos (ingredients) with moving-average cost + stock. Stock moves via
 * compras (recibir) and orden charges (recipe relief) — this endpoint only
 * manages the catalog + manual stock/cost corrections via PATCH on [id].
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "RESTAURANTE", req);

  const q = searchParams.get("q");
  const lowStock = searchParams.get("lowStock") === "true";

  const insumos = await prisma.restInsumo.findMany({
    where: {
      companyId,
      ...(q ? { nombre: { contains: q, mode: "insensitive" } } : {}),
    },
    orderBy: [{ activo: "desc" }, { nombre: "asc" }],
  });

  const filtered = lowStock
    ? insumos.filter((i) => i.activo && i.stockMinimo > 0 && i.stock <= i.stockMinimo)
    : insumos;

  return NextResponse.json(filtered);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  nombre: z.string().min(1).max(120).transform((v) => v.trim()),
  categoria: z.string().max(60).nullable().optional(),
  unidad: z.enum(["KG", "G", "L", "ML", "PZA"]).default("PZA"),
  costoPromedio: z.number().min(0).default(0),
  stock: z.number().default(0),
  stockMinimo: z.number().min(0).default(0),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, ...data } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "RESTAURANTE", req);

  const existing = await prisma.restInsumo.findUnique({
    where: { companyId_nombre: { companyId, nombre: data.nombre } },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: `Ya existe un insumo llamado «${data.nombre}»` },
      { status: 409 }
    );
  }

  const insumo = await prisma.restInsumo.create({ data: { companyId, ...data } });
  return NextResponse.json(insumo, { status: 201 });
});
