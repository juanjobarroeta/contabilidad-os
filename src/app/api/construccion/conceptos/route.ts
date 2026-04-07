/**
 * Conceptos — catálogo de conceptos de obra.
 *
 * Each concepto is the header of an APU (Análisis de Precios Unitarios).
 * One concepto → many APU versions; the current/active version is pinned
 * via `apuActualId`. Creating a concepto auto-creates a version-1 APU
 * (empty insumos, precioUnitario=0) and points `apuActualId` at it, so
 * the caller never has to think about the two-step process.
 *
 * GET  /api/construccion/conceptos?companyId=...&q=...&categoria=...
 * POST /api/construccion/conceptos
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

const createConceptoSchema = z.object({
  companyId: z.string().min(1),
  codigo: z.string().min(1).max(40),
  descripcion: z.string().min(1),
  unidad: z.string().min(1).max(10),
  categoria: z.string().optional(),
});

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const q = searchParams.get("q")?.trim();
  const categoria = searchParams.get("categoria");

  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "CONSTRUCCION");

  const where: Prisma.ConceptoWhereInput = { companyId };
  if (categoria) where.categoria = categoria;
  if (q) {
    where.OR = [
      { codigo: { contains: q, mode: "insensitive" } },
      { descripcion: { contains: q, mode: "insensitive" } },
    ];
  }

  const conceptos = await prisma.concepto.findMany({
    where,
    include: {
      apuActual: {
        select: {
          id: true,
          version: true,
          costoDirecto: true,
          precioUnitario: true,
          indirectosPorc: true,
          utilidadPorc: true,
          _count: { select: { insumos: true } },
        },
      },
    },
    orderBy: [{ categoria: "asc" }, { codigo: "asc" }],
    take: 500,
  });
  return NextResponse.json(conceptos);
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json();
  const parsed = createConceptoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  await requireWriter(data.companyId, req);
  await requireModule(data.companyId, "CONSTRUCCION");

  // Create concepto + empty v1 APU + pin apuActual in one transaction.
  try {
    const concepto = await prisma.$transaction(async (tx) => {
      const created = await tx.concepto.create({
        data: {
          companyId: data.companyId,
          codigo: data.codigo,
          descripcion: data.descripcion,
          unidad: data.unidad,
          categoria: data.categoria,
        },
      });

      const apu = await tx.aPU.create({
        data: {
          companyId: data.companyId,
          conceptoId: created.id,
          version: 1,
          costoDirecto: 0,
          indirectosPorc: 0,
          financierosPorc: 0,
          utilidadPorc: 0,
          cargosAdicPorc: 0,
          precioUnitario: 0,
          rendimiento: 1,
        },
      });

      return tx.concepto.update({
        where: { id: created.id },
        data: { apuActualId: apu.id },
        include: {
          apuActual: {
            select: {
              id: true,
              version: true,
              costoDirecto: true,
              precioUnitario: true,
              indirectosPorc: true,
              utilidadPorc: true,
              _count: { select: { insumos: true } },
            },
          },
        },
      });
    });
    return NextResponse.json(concepto, { status: 201 });
  } catch (e: unknown) {
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { code: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "Ya existe un concepto con ese código" },
        { status: 409 }
      );
    }
    throw e;
  }
});
