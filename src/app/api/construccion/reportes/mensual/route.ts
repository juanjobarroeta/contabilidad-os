/**
 * GET /api/construccion/reportes/mensual?companyId=...
 *       [&proyectoId=...] [&year=YYYY]
 *
 * Monthly rollup answering "¿qué pasó este mes?" without bouncing
 * across pages. For each month in the requested year (default current),
 * returns: gastado directo, gastado indirecto, n\u00f3mina destajo (Rayas),
 * compras pagadas, ingresos (estimaciones cobradas), and the net flow
 * from BankTransactions.
 *
 * Response:
 *   {
 *     year, proyectoId?, currency,
 *     totals: { gastado, ingresado, neto },
 *     meses: [
 *       {
 *         mes: 1..12, label: 'Enero',
 *         gastoDirecto: 0, gastoIndirecto: 0,
 *         destajoRayas: 0, comprasPagadas: 0,
 *         ingresosEstimaciones: 0,
 *         flowBancario: 0,         // sum of monto in BankTransactions
 *         topIndirectos: [{ categoria, total }, ...top 3],
 *         topInsumos:    [{ codigo, descripcion, total }, ...top 5],
 *       },
 *       ...
 *     ]
 *   }
 *
 * Used by the bartiz Reportes page to drive the "monthly variance"
 * conversation Gerry asked for. Reuses /consumo-insumos shape for the
 * top insumos block.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  requireMembership,
  requireModule,
  withAuthz,
} from "@/lib/authz";

const MES_LABEL = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

const round2 = (n: number) => Math.round(n * 100) / 100;

export const GET = withAuthz(async (req: Request) => {
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId");
  const proyectoId = url.searchParams.get("proyectoId");
  const year = parseInt(url.searchParams.get("year") ?? `${new Date().getFullYear()}`, 10);

  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "CONSTRUCCION");

  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year + 1, 0, 1);

  // Common filter prefix
  const proyectoFilter = proyectoId ? { proyectoId } : {};

  // Pull all relevant rows in one shot per source, group in JS
  const [gastos, rayas, solicitudes, estimaciones, banktxs] = await Promise.all([
    prisma.gasto.findMany({
      where: {
        companyId,
        ...proyectoFilter,
        estado: { in: ["APROBADO", "PAGADO"] },
        createdAt: { gte: yearStart, lt: yearEnd },
      },
      select: {
        importe: true,
        indirecto: true,
        categoriaIndirecto: true,
        insumoId: true,
        createdAt: true,
        pagadoAt: true,
        insumo: { select: { codigo: true, descripcion: true } },
      },
    }),
    prisma.rayaSemanal.findMany({
      where: {
        companyId,
        ...proyectoFilter,
        estado: "PAGADA",
        pagadaAt: { gte: yearStart, lt: yearEnd },
      },
      select: { totalDestajo: true, pagadaAt: true },
    }).catch(() => [] as { totalDestajo: number; pagadaAt: Date | null }[]),
    prisma.solicitudCompra.findMany({
      where: {
        companyId,
        ...proyectoFilter,
        estado: "PAGADA",
        pagadaAt: { gte: yearStart, lt: yearEnd },
      },
      select: { total: true, pagadaAt: true },
    }),
    prisma.estimacion.findMany({
      where: {
        companyId,
        ...proyectoFilter,
        estado: { in: ["TIMBRADA", "PAGADA"] },
        createdAt: { gte: yearStart, lt: yearEnd },
      },
      select: { subtotal: true, total: true, createdAt: true },
    }),
    prisma.bankTransaction.findMany({
      where: { companyId, fecha: { gte: yearStart, lt: yearEnd } },
      select: { monto: true, fecha: true, tipo: true },
    }),
  ]);

  // Build 12 month buckets
  const meses = Array.from({ length: 12 }, (_, i) => ({
    mes: i + 1,
    label: MES_LABEL[i],
    gastoDirecto: 0,
    gastoIndirecto: 0,
    destajoRayas: 0,
    comprasPagadas: 0,
    ingresosEstimaciones: 0,
    flowBancario: 0,
    indirectosByCat: new Map<string, number>(),
    insumosByCodigo: new Map<string, { codigo: string; descripcion: string; total: number }>(),
  }));

  for (const g of gastos) {
    const d = g.pagadoAt ?? g.createdAt;
    const m = meses[d.getMonth()];
    if (g.indirecto) {
      m.gastoIndirecto += g.importe;
      const cat = g.categoriaIndirecto ?? "OTROS";
      m.indirectosByCat.set(cat, (m.indirectosByCat.get(cat) ?? 0) + g.importe);
    } else {
      m.gastoDirecto += g.importe;
      if (g.insumo) {
        const key = g.insumo.codigo;
        const cur = m.insumosByCodigo.get(key) ?? {
          codigo: key,
          descripcion: g.insumo.descripcion,
          total: 0,
        };
        cur.total += g.importe;
        m.insumosByCodigo.set(key, cur);
      }
    }
  }

  for (const r of rayas) {
    if (!r.pagadaAt) continue;
    meses[r.pagadaAt.getMonth()].destajoRayas += r.totalDestajo;
  }
  for (const s of solicitudes) {
    if (!s.pagadaAt) continue;
    meses[s.pagadaAt.getMonth()].comprasPagadas += s.total;
  }
  for (const e of estimaciones) {
    meses[e.createdAt.getMonth()].ingresosEstimaciones += e.subtotal;
  }
  for (const b of banktxs) {
    meses[b.fecha.getMonth()].flowBancario += b.monto;
  }

  // Reduce maps → sorted top-N arrays
  const out = meses.map((m) => ({
    mes: m.mes,
    label: m.label,
    gastoDirecto: round2(m.gastoDirecto),
    gastoIndirecto: round2(m.gastoIndirecto),
    destajoRayas: round2(m.destajoRayas),
    comprasPagadas: round2(m.comprasPagadas),
    ingresosEstimaciones: round2(m.ingresosEstimaciones),
    flowBancario: round2(m.flowBancario),
    totalGastado: round2(m.gastoDirecto + m.gastoIndirecto + m.destajoRayas + m.comprasPagadas),
    topIndirectos: [...m.indirectosByCat.entries()]
      .map(([categoria, total]) => ({ categoria, total: round2(total) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5),
    topInsumos: [...m.insumosByCodigo.values()]
      .map((x) => ({ ...x, total: round2(x.total) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5),
  }));

  const totals = {
    gastado: round2(out.reduce((a, m) => a + m.totalGastado, 0)),
    ingresado: round2(out.reduce((a, m) => a + m.ingresosEstimaciones, 0)),
    neto: round2(
      out.reduce((a, m) => a + m.ingresosEstimaciones - m.totalGastado, 0)
    ),
  };

  return NextResponse.json({
    year,
    proyectoId: proyectoId ?? null,
    currency: "MXN",
    totals,
    meses: out,
  });
});
