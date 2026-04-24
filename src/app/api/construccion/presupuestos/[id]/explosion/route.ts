/**
 * GET /api/construccion/presupuestos/[id]/explosion
 *
 * Explosión de insumos: from a presupuesto, generates the total list of
 * all materials, labor, and equipment needed across all partidas.
 *
 * For each presupuesto partida:
 *   partida.cantidad × each APUInsumo.cantidad = total insumo needed
 *
 * Results are aggregated by insumo (deduplicated across partidas) and
 * grouped by tipo (MATERIAL, MANO_OBRA, EQUIPO).
 *
 * This is what Neodata calls "explosión de insumos" — the shopping list
 * you need to buy everything for the project. Critical for purchasing.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireMembership,
  requireModule,
  withAuthz,
} from "@/lib/authz";

const round2 = (n: number) => Math.round(n * 100) / 100;

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const presupuesto = await prisma.presupuesto.findUnique({
      where: { id },
      select: {
        id: true,
        companyId: true,
        nombre: true,
        montoTotal: true,
        partidas: {
          // Rollup branches have no concepto and no cantidad — skip them,
          // their children's importes are what we want to aggregate.
          where: { esRollup: false },
          select: {
            cantidad: true,
            concepto: {
              select: {
                codigo: true,
                apuActual: {
                  select: {
                    insumos: {
                      select: {
                        cantidad: true,
                        costoUnitario: true,
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
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!presupuesto) {
      throw new AuthzError(404, "Presupuesto no encontrado");
    }

    await requireMembership(presupuesto.companyId, undefined, req);
    await requireModule(presupuesto.companyId, "CONSTRUCCION");

    // Aggregate: for each insumo, sum (partidaCantidad × apuInsumoCantidad)
    const byInsumoId = new Map<
      string,
      {
        insumoId: string;
        codigo: string;
        descripcion: string;
        tipo: string;
        unidad: string;
        costoUnitario: number;
        cantidadTotal: number;
        importeTotal: number;
        usedInConceptos: Set<string>;
      }
    >();

    for (const partida of presupuesto.partidas) {
      if (partida.cantidad == null) continue; // defensive — leaves always have cantidad
      const apuInsumos = partida.concepto?.apuActual?.insumos ?? [];
      for (const line of apuInsumos) {
        // Skip sub-APU lines (conceptoRef) — they'll be expanded separately
        // if/when we add recursive explosion. For now, only raw insumos.
        if (!line.insumo) continue;

        const totalQty = round2(partida.cantidad * line.cantidad);
        const totalCost = round2(totalQty * line.costoUnitario);

        if (!byInsumoId.has(line.insumo.id)) {
          byInsumoId.set(line.insumo.id, {
            insumoId: line.insumo.id,
            codigo: line.insumo.codigo,
            descripcion: line.insumo.descripcion,
            tipo: line.insumo.tipo,
            unidad: line.insumo.unidad,
            costoUnitario: line.costoUnitario,
            cantidadTotal: 0,
            importeTotal: 0,
            usedInConceptos: new Set(),
          });
        }

        const entry = byInsumoId.get(line.insumo.id)!;
        entry.cantidadTotal = round2(entry.cantidadTotal + totalQty);
        entry.importeTotal = round2(entry.importeTotal + totalCost);
        if (partida.concepto?.codigo) {
          entry.usedInConceptos.add(partida.concepto.codigo);
        }
      }
    }

    // Convert to array, grouped by tipo
    const explosion = [...byInsumoId.values()]
      .map((e) => ({
        ...e,
        usedInConceptos: [...e.usedInConceptos],
      }))
      .sort((a, b) => {
        const tipoOrder: Record<string, number> = {
          MATERIAL: 0,
          MANO_OBRA: 1,
          EQUIPO: 2,
          HERRAMIENTA: 3,
          BASICO: 4,
        };
        const ta = tipoOrder[a.tipo] ?? 5;
        const tb = tipoOrder[b.tipo] ?? 5;
        if (ta !== tb) return ta - tb;
        return a.codigo.localeCompare(b.codigo);
      });

    const totalMateriales = round2(
      explosion.filter((e) => e.tipo === "MATERIAL").reduce((a, e) => a + e.importeTotal, 0)
    );
    const totalManoObra = round2(
      explosion.filter((e) => e.tipo === "MANO_OBRA").reduce((a, e) => a + e.importeTotal, 0)
    );
    const totalEquipo = round2(
      explosion
        .filter((e) => ["EQUIPO", "HERRAMIENTA"].includes(e.tipo))
        .reduce((a, e) => a + e.importeTotal, 0)
    );

    return NextResponse.json({
      presupuestoId: presupuesto.id,
      presupuestoNombre: presupuesto.nombre,
      montoTotal: presupuesto.montoTotal,
      resumen: {
        totalMateriales,
        totalManoObra,
        totalEquipo,
        totalCostoDirecto: round2(totalMateriales + totalManoObra + totalEquipo),
        insumoCount: explosion.length,
      },
      explosion,
    });
  }
);
