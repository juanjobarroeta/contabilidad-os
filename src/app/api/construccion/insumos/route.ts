/**
 * Insumos — master list of inputs: materials, labor, equipment, basics.
 *
 * Catálogo base that every APU line draws from. Multi-tenant: rows are
 * scoped by companyId + unique by (companyId, codigo).
 *
 * GET  /api/construccion/insumos?companyId=...&q=...&tipo=MATERIAL
 * POST /api/construccion/insumos
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  requireMembership,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";
import type { Prisma } from "@prisma/client";

const INSUMO_TIPOS = ["MATERIAL", "MANO_OBRA", "EQUIPO", "HERRAMIENTA", "BASICO"] as const;

const createInsumoSchema = z.object({
  companyId: z.string().min(1),
  codigo: z.string().min(1).max(40),
  descripcion: z.string().min(1),
  tipo: z.enum(INSUMO_TIPOS),
  unidad: z.string().min(1).max(10),
  costoActual: z.number().nonnegative(),
  monedaCosto: z.string().optional().default("MXN"),
  salarioBase: z.number().nonnegative().optional(),
  factorSalario: z.number().nonnegative().optional(),
  claveProdServ: z.string().optional(),
  claveUnidad: z.string().optional(),
});

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const q = searchParams.get("q")?.trim();
  const tipo = searchParams.get("tipo");

  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "CONSTRUCCION");

  const where: Prisma.InsumoWhereInput = { companyId };
  if (tipo && (INSUMO_TIPOS as readonly string[]).includes(tipo)) {
    where.tipo = tipo as (typeof INSUMO_TIPOS)[number];
  }
  if (q) {
    where.OR = [
      { codigo: { contains: q, mode: "insensitive" } },
      { descripcion: { contains: q, mode: "insensitive" } },
    ];
  }

  const insumos = await prisma.insumo.findMany({
    where,
    orderBy: [{ tipo: "asc" }, { codigo: "asc" }],
    take: 500,
  });
  return NextResponse.json(insumos);
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json();
  const parsed = createInsumoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  await requireWriter(data.companyId, req);
  await requireModule(data.companyId, "CONSTRUCCION");

  try {
    const insumo = await prisma.insumo.create({
      data: {
        companyId: data.companyId,
        codigo: data.codigo,
        descripcion: data.descripcion,
        tipo: data.tipo,
        unidad: data.unidad,
        costoActual: data.costoActual,
        monedaCosto: data.monedaCosto,
        salarioBase: data.salarioBase,
        factorSalario: data.factorSalario,
        claveProdServ: data.claveProdServ,
        claveUnidad: data.claveUnidad,
      },
    });
    return NextResponse.json(insumo, { status: 201 });
  } catch (e: unknown) {
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { code: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "Ya existe un insumo con ese código" },
        { status: 409 }
      );
    }
    throw e;
  }
});
