/**
 * GET  /api/restaurante/menu/categorias?companyId=...
 * POST /api/restaurante/menu/categorias
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

  const categorias = await prisma.restMenuCategoria.findMany({
    where: { companyId },
    orderBy: [{ orden: "asc" }, { nombre: "asc" }],
  });
  return NextResponse.json(categorias);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  nombre: z.string().min(1).max(80).transform((v) => v.trim()),
  orden: z.number().int().default(0),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, nombre, orden } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "RESTAURANTE", req);

  const existing = await prisma.restMenuCategoria.findUnique({
    where: { companyId_nombre: { companyId, nombre } },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: `Ya existe la categoría «${nombre}»` },
      { status: 409 }
    );
  }

  const categoria = await prisma.restMenuCategoria.create({
    data: { companyId, nombre, orden },
  });
  return NextResponse.json(categoria, { status: 201 });
});
