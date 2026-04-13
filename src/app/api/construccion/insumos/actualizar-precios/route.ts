/**
 * POST /api/construccion/insumos/actualizar-precios
 *
 * Bulk price update: takes a list of { codigo, nuevoCosto } and updates
 * each Insumo's costoActual. Then finds every APU that uses any of the
 * updated insumos, recomputes their costoDirecto and precioUnitario,
 * and returns a summary of what changed.
 *
 * This is the "cement went up 10%" button. One call, all affected APUs
 * across all conceptos update their PUs automatically.
 *
 * Body: {
 *   companyId: string,
 *   precios: [
 *     { codigo: "QUIMHER", nuevoCosto: 620 },
 *     { codigo: "MO011", nuevoCosto: 700 },
 *     ...
 *   ]
 * }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

const round2 = (n: number) => Math.round(n * 100) / 100;

const updateSchema = z.object({
  companyId: z.string().min(1),
  precios: z.array(
    z.object({
      codigo: z.string().min(1),
      nuevoCosto: z.number().nonnegative(),
    })
  ).min(1),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, precios } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "CONSTRUCCION");

  const results = await prisma.$transaction(async (tx) => {
    const updatedInsumos: Array<{ codigo: string; antes: number; despues: number }> = [];
    const affectedApuIds = new Set<string>();

    // 1. Update each insumo's costoActual
    for (const { codigo, nuevoCosto } of precios) {
      const insumo = await tx.insumo.findUnique({
        where: { companyId_codigo: { companyId, codigo } },
        select: { id: true, costoActual: true },
      });
      if (!insumo) continue;

      if (insumo.costoActual !== nuevoCosto) {
        await tx.insumo.update({
          where: { companyId_codigo: { companyId, codigo } },
          data: { costoActual: nuevoCosto },
        });
        updatedInsumos.push({
          codigo,
          antes: insumo.costoActual,
          despues: nuevoCosto,
        });

        // Find all APUs that use this insumo
        const apuLines = await tx.aPUInsumo.findMany({
          where: { insumoId: insumo.id },
          select: { apuId: true, id: true, cantidad: true },
        });
        for (const line of apuLines) {
          affectedApuIds.add(line.apuId);
          // Update the line's costoUnitario + importe
          await tx.aPUInsumo.update({
            where: { id: line.id },
            data: {
              costoUnitario: nuevoCosto,
              importe: round2(line.cantidad * nuevoCosto),
            },
          });
        }
      }
    }

    // 2. Recompute each affected APU's costoDirecto + precioUnitario
    const updatedApus: Array<{
      conceptoCodigo: string;
      puAntes: number;
      puDespues: number;
    }> = [];

    for (const apuId of affectedApuIds) {
      const apu = await tx.aPU.findUnique({
        where: { id: apuId },
        include: {
          insumos: true,
          concepto: { select: { codigo: true } },
        },
      });
      if (!apu) continue;

      const puAntes = apu.precioUnitario;
      const costoDirecto = round2(
        apu.insumos.reduce((a, l) => a + l.importe, 0)
      );
      const rendimiento = apu.rendimiento > 0 ? apu.rendimiento : 1;
      const subtotal1 = costoDirecto * (1 + apu.indirectosPorc);
      const subtotal2 = subtotal1 * (1 + apu.financierosPorc);
      const precioUnitario = round2(
        (subtotal2 * (1 + apu.utilidadPorc + apu.cargosAdicPorc)) / rendimiento
      );

      await tx.aPU.update({
        where: { id: apuId },
        data: { costoDirecto, precioUnitario },
      });

      updatedApus.push({
        conceptoCodigo: apu.concepto?.codigo ?? apuId,
        puAntes,
        puDespues: precioUnitario,
      });
    }

    return { updatedInsumos, updatedApus };
  });

  return NextResponse.json({
    insumosActualizados: results.updatedInsumos.length,
    apusAfectados: results.updatedApus.length,
    detalle: results,
  });
});
