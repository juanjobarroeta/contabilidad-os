/**
 * Mutating an APU — the core flow of the APU editor.
 *
 * POST   /api/construccion/apus/[id]/insumos         → add a line
 * PUT    /api/construccion/apus/[id]/insumos         → replace all lines (bulk save)
 *
 * Each mutation recomputes:
 *   costoDirecto  = Σ(cantidad × costoUnitario)
 *   precioUnitario = costoDirecto × (1 + indirectosPorc + financierosPorc +
 *                                       utilidadPorc + cargosAdicPorc) / rendimiento
 *
 * ...and writes the new totals back to the APU row in the same transaction
 * so the frontend can rely on the returned APU being authoritative.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";
import type { Prisma } from "@prisma/client";

const lineSchema = z.object({
  insumoId: z.string().min(1),
  cantidad: z.number().positive(),
  costoUnitario: z.number().nonnegative(),
  orden: z.number().int().nonnegative().optional(),
});

const addLineBody = lineSchema;
const replaceLinesBody = z.object({
  lines: z.array(lineSchema),
  // Optional overhead overrides (percentages expressed as decimals, e.g. 0.12)
  indirectosPorc: z.number().nonnegative().optional(),
  financierosPorc: z.number().nonnegative().optional(),
  utilidadPorc: z.number().nonnegative().optional(),
  cargosAdicPorc: z.number().nonnegative().optional(),
  rendimiento: z.number().positive().optional(),
});

type Tx = Prisma.TransactionClient;

/**
 * Recomputes and writes the roll-up totals on an APU given its current
 * insumo rows. Must be called inside a transaction after adding/removing
 * lines so totals stay consistent.
 */
async function recomputeApuTotals(tx: Tx, apuId: string) {
  const apu = await tx.aPU.findUnique({
    where: { id: apuId },
    include: { insumos: true },
  });
  if (!apu) throw new Error("apu not found during recompute");

  const costoDirecto = apu.insumos.reduce((acc, l) => acc + l.importe, 0);
  // Cascading overhead formula matching Mexican construction standard:
  //   subtotal1 = CD + (CD × indirectos)
  //   subtotal2 = subtotal1 + (subtotal1 × financieros)
  //   PU        = subtotal2 + (subtotal2 × utilidad) + (subtotal2 × cargosAdic)
  // Then divide by rendimiento if > 1.
  const rendimiento = apu.rendimiento > 0 ? apu.rendimiento : 1;
  const subtotal1 = costoDirecto * (1 + apu.indirectosPorc);
  const subtotal2 = subtotal1 * (1 + apu.financierosPorc);
  const precioUnitario =
    (subtotal2 * (1 + apu.utilidadPorc + apu.cargosAdicPorc)) / rendimiento;

  return tx.aPU.update({
    where: { id: apuId },
    data: {
      costoDirecto: round2(costoDirecto),
      precioUnitario: round2(precioUnitario),
    },
    include: {
      insumos: {
        include: {
          insumo: {
            select: {
              id: true,
              codigo: true,
              descripcion: true,
              tipo: true,
              unidad: true,
              costoActual: true,
            },
          },
        },
        orderBy: { orden: "asc" },
      },
    },
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Validates that the APU exists, is owned by a company the user can write,
 * has the CONSTRUCCION module enabled, and the referenced insumoIds belong
 * to the same company. Returns the APU.
 */
async function loadAndGuardApu(id: string, req: Request) {
  const apu = await prisma.aPU.findUnique({
    where: { id },
    select: { id: true, companyId: true },
  });
  if (!apu) throw new AuthzError(404, "APU no encontrado");
  await requireWriter(apu.companyId, req);
  await requireModule(apu.companyId, "CONSTRUCCION");
  return apu;
}

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json();
    const parsed = addLineBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const apu = await loadAndGuardApu(id, req);

    // Ensure the insumo is from the same company
    const insumo = await prisma.insumo.findUnique({
      where: { id: parsed.data.insumoId },
      select: { companyId: true },
    });
    if (!insumo || insumo.companyId !== apu.companyId) {
      return NextResponse.json({ error: "Insumo inválido" }, { status: 400 });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const count = await tx.aPUInsumo.count({ where: { apuId: id } });
      await tx.aPUInsumo.create({
        data: {
          apuId: id,
          insumoId: parsed.data.insumoId,
          cantidad: parsed.data.cantidad,
          costoUnitario: parsed.data.costoUnitario,
          importe: round2(parsed.data.cantidad * parsed.data.costoUnitario),
          orden: parsed.data.orden ?? count,
        },
      });
      return recomputeApuTotals(tx, id);
    });

    return NextResponse.json(updated);
  }
);

export const PUT = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await req.json();
    const parsed = replaceLinesBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const apu = await loadAndGuardApu(id, req);

    // Verify every insumo id belongs to the same company in one query
    if (parsed.data.lines.length) {
      const ids = [...new Set(parsed.data.lines.map((l) => l.insumoId))];
      const count = await prisma.insumo.count({
        where: { id: { in: ids }, companyId: apu.companyId },
      });
      if (count !== ids.length) {
        return NextResponse.json({ error: "Uno o más insumos son inválidos" }, { status: 400 });
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Apply optional overhead overrides first — they affect recompute
      const overheadPatch: Prisma.APUUpdateInput = {};
      if (parsed.data.indirectosPorc !== undefined) overheadPatch.indirectosPorc = parsed.data.indirectosPorc;
      if (parsed.data.financierosPorc !== undefined) overheadPatch.financierosPorc = parsed.data.financierosPorc;
      if (parsed.data.utilidadPorc !== undefined) overheadPatch.utilidadPorc = parsed.data.utilidadPorc;
      if (parsed.data.cargosAdicPorc !== undefined) overheadPatch.cargosAdicPorc = parsed.data.cargosAdicPorc;
      if (parsed.data.rendimiento !== undefined) overheadPatch.rendimiento = parsed.data.rendimiento;
      if (Object.keys(overheadPatch).length) {
        await tx.aPU.update({ where: { id }, data: overheadPatch });
      }

      await tx.aPUInsumo.deleteMany({ where: { apuId: id } });

      if (parsed.data.lines.length) {
        await tx.aPUInsumo.createMany({
          data: parsed.data.lines.map((l, idx) => ({
            apuId: id,
            insumoId: l.insumoId,
            cantidad: l.cantidad,
            costoUnitario: l.costoUnitario,
            importe: round2(l.cantidad * l.costoUnitario),
            orden: l.orden ?? idx,
          })),
        });
      }

      return recomputeApuTotals(tx, id);
    });

    return NextResponse.json(updated);
  }
);
