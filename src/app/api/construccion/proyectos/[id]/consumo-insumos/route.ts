/**
 * GET /api/construccion/proyectos/[id]/consumo-insumos
 *
 * Neodata-style "Explosión vs Real" view: for every insumo that shows
 * up in the proyecto's APUs OR in any gasto linked to the project,
 * return planeado (from APU matrices × partida cantidades) vs. real
 * (sum of Gasto.cantidad / Gasto.importe).
 *
 * Response shape:
 *   {
 *     totals: {
 *       planeadoImporte: 12_345_678,
 *       realImporte:     300_000,
 *       planeadoMO:      1_234_567,
 *       realMO:          45_000,
 *       indirectosTotal: 75_000
 *     },
 *     insumos: [
 *       {
 *         id, codigo, descripcion, unidad, tipo,
 *         puCatalogo,        // Insumo.costoActual
 *         planeadoCantidad,  // Σ APUInsumo.cantidad × PresupuestoPartida.cantidad
 *         planeadoImporte,   // planeadoCantidad × puCatalogo
 *         realCantidad,      // Σ Gasto.cantidad (where insumoId matches)
 *         realImporte,       // Σ Gasto.importe
 *         puPromedioReal,    // realImporte / realCantidad (if cantidad set)
 *         variancePct,       // (puPromedioReal - puCatalogo) / puCatalogo × 100
 *         gastoCount,        // how many gastos fed this insumo
 *         partidaRefs: [     // which partidas use this insumo in their APUs
 *           { partidaId, codigo, concepto: { codigo } }, ...
 *         ]
 *       },
 *       ...
 *     ],
 *     indirectos: [   // gastos marked indirecto, aggregated by categoría
 *       { categoria, totalImporte, count }, ...
 *     ]
 *   }
 *
 * Gerry's Neodata ask answered: "¿qué gastamos vs qué planeamos, por
 * material?". Variance highlights over-budget material BEFORE the
 * entire project blows up.
 *
 * Scope: uses the APUROLL-up pattern — for each presupuesto partida
 * (APROBADO or EN_EJECUCION), walk its concepto's apuActual.insumos
 * and multiply. If a presupuesto has no APUs (Decolsa's Torres Platino
 * currently), planeado is zero and the table shows only real consumption.
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

    const proyecto = await prisma.proyecto.findUnique({
      where: { id },
      select: { id: true, companyId: true },
    });
    if (!proyecto) throw new AuthzError(404, "Proyecto no encontrado");
    await requireMembership(proyecto.companyId, undefined, req);
    await requireModule(proyecto.companyId, "CONSTRUCCION");

    // ── Planeado: walk APUROLL ────────────────────────────────────────
    // Pick one presupuesto as the basis. Prefer EJECUTADO; else APROBADO
    // contrato; else first BORRADOR. Skip rollup branches.
    const presupuestos = await prisma.presupuesto.findMany({
      where: { proyectoId: id },
      orderBy: [{ tipoPresupuesto: "desc" }, { version: "desc" }],
      select: { id: true, estado: true, tipoPresupuesto: true },
    });
    const basis =
      presupuestos.find((p) => p.tipoPresupuesto === "EJECUTADO") ??
      presupuestos.find((p) => p.estado === "APROBADO") ??
      presupuestos[0];

    type PlaneadoAgg = {
      planeadoCantidad: number;
      partidaRefs: Array<{
        partidaId: string;
        codigo: string | null;
        conceptoCodigo: string | null;
        conceptoDescripcion: string | null;
      }>;
    };
    const planeadoByInsumoId = new Map<string, PlaneadoAgg>();

    if (basis) {
      const partidas = await prisma.presupuestoPartida.findMany({
        where: {
          presupuestoId: basis.id,
          esRollup: false,
          cantidad: { not: null },
          conceptoId: { not: null },
        },
        select: {
          id: true,
          codigo: true,
          cantidad: true,
          concepto: {
            select: {
              codigo: true,
              descripcion: true,
              apuActual: {
                select: {
                  insumos: {
                    where: { insumoId: { not: null } },
                    select: {
                      cantidad: true,
                      insumoId: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      for (const p of partidas) {
        const partidaQty = p.cantidad ?? 0;
        const lines = p.concepto?.apuActual?.insumos ?? [];
        for (const line of lines) {
          if (!line.insumoId) continue;
          const agg =
            planeadoByInsumoId.get(line.insumoId) ??
            ({ planeadoCantidad: 0, partidaRefs: [] } as PlaneadoAgg);
          agg.planeadoCantidad += partidaQty * (line.cantidad ?? 0);
          // Dedup partidaRefs so one partida appears once even if it
          // consumes the same insumo twice.
          if (!agg.partidaRefs.find((r) => r.partidaId === p.id)) {
            agg.partidaRefs.push({
              partidaId: p.id,
              codigo: p.codigo,
              conceptoCodigo: p.concepto?.codigo ?? null,
              conceptoDescripcion: p.concepto?.descripcion ?? null,
            });
          }
          planeadoByInsumoId.set(line.insumoId, agg);
        }
      }
    }

    // ── Real: sum gastos por insumoId (estado PAGADO + APROBADO) ──────
    const realAgg = await prisma.gasto.groupBy({
      by: ["insumoId"],
      where: {
        proyectoId: id,
        insumoId: { not: null },
        estado: { in: ["APROBADO", "PAGADO"] },
      },
      _sum: { cantidad: true, importe: true },
      _count: true,
    });
    const realByInsumoId = new Map<string, { cantidad: number; importe: number; count: number }>();
    for (const row of realAgg) {
      if (!row.insumoId) continue;
      realByInsumoId.set(row.insumoId, {
        cantidad: row._sum.cantidad ?? 0,
        importe: row._sum.importe ?? 0,
        count: row._count,
      });
    }

    // ── Union of insumo ids from both sides; load metadata ────────────
    const allIds = new Set<string>([
      ...planeadoByInsumoId.keys(),
      ...realByInsumoId.keys(),
    ]);
    const insumoRows = await prisma.insumo.findMany({
      where: { id: { in: [...allIds] } },
      select: {
        id: true,
        codigo: true,
        descripcion: true,
        unidad: true,
        tipo: true,
        costoActual: true,
      },
    });
    const insumoById = new Map(insumoRows.map((i) => [i.id, i]));

    const insumos = [...allIds]
      .map((iid) => {
        const meta = insumoById.get(iid);
        if (!meta) return null;
        const planeado = planeadoByInsumoId.get(iid);
        const real = realByInsumoId.get(iid);
        const planeadoCantidad = round2(planeado?.planeadoCantidad ?? 0);
        const puCatalogo = meta.costoActual ?? 0;
        const planeadoImporte = round2(planeadoCantidad * puCatalogo);
        const realCantidad = round2(real?.cantidad ?? 0);
        const realImporte = round2(real?.importe ?? 0);
        const puPromedioReal = realCantidad > 0 ? round2(realImporte / realCantidad) : null;
        const variancePct =
          puPromedioReal != null && puCatalogo > 0
            ? round2(((puPromedioReal - puCatalogo) / puCatalogo) * 100)
            : null;
        return {
          id: meta.id,
          codigo: meta.codigo,
          descripcion: meta.descripcion,
          unidad: meta.unidad,
          tipo: meta.tipo,
          puCatalogo,
          planeadoCantidad,
          planeadoImporte,
          realCantidad,
          realImporte,
          puPromedioReal,
          variancePct,
          gastoCount: real?.count ?? 0,
          partidaRefs: planeado?.partidaRefs ?? [],
        };
      })
      .filter(Boolean);

    // Indirectos breakdown (parallel question: "¿cuánto se fue en overhead?")
    const indirectosRows = await prisma.gasto.groupBy({
      by: ["categoriaIndirecto"],
      where: {
        proyectoId: id,
        indirecto: true,
        estado: { in: ["APROBADO", "PAGADO"] },
      },
      _sum: { importe: true },
      _count: true,
    });
    const indirectos = indirectosRows
      .filter((r) => r.categoriaIndirecto)
      .map((r) => ({
        categoria: r.categoriaIndirecto!,
        totalImporte: round2(r._sum.importe ?? 0),
        count: r._count,
      }))
      .sort((a, b) => b.totalImporte - a.totalImporte);

    const totals = {
      planeadoImporte: round2(
        insumos.reduce((a, i) => a + (i?.planeadoImporte ?? 0), 0)
      ),
      realImporte: round2(
        insumos.reduce((a, i) => a + (i?.realImporte ?? 0), 0)
      ),
      planeadoMO: round2(
        insumos
          .filter((i) => i?.tipo === "MANO_OBRA")
          .reduce((a, i) => a + (i?.planeadoImporte ?? 0), 0)
      ),
      realMO: round2(
        insumos
          .filter((i) => i?.tipo === "MANO_OBRA")
          .reduce((a, i) => a + (i?.realImporte ?? 0), 0)
      ),
      indirectosTotal: round2(
        indirectos.reduce((a, c) => a + c.totalImporte, 0)
      ),
    };

    return NextResponse.json({ totals, insumos, indirectos });
  }
);
