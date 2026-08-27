/**
 * GET /api/construccion/gastos/sugerir?companyId=...&proyectoId=...&q=...
 *
 * Katia types "varilla arena" and we return the top N best-matching
 * Insumos (master material catalog) and PresupuestoPartidas (budget
 * leaves in this specific proyecto's presupuesto), each with budget
 * context: planeado vs gastado vs queda.
 *
 * This is the value-add of the whole Gastos feature — instead of
 * making Katia browse a tree she doesn't remember, she types what
 * Rosy said and picks from ranked suggestions.
 *
 * Ranking is a cheap token-overlap heuristic — good enough for the
 * ~500 insumos Bartiz/Decolsa have; upgrade to trigram or pg full-text
 * if it ever hits thousands.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

// Strip accents + punctuation, split on whitespace
const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{Letter}\p{Number}\s/#-]+/gu, " ")
    .trim();

const tokenize = (s: string) =>
  normalize(s).split(/\s+/).filter((t) => t.length >= 2);

function scoreMatch(haystack: string, needles: string[]): number {
  const h = normalize(haystack);
  let score = 0;
  for (const n of needles) {
    if (!n) continue;
    if (h.includes(n)) score += 10 + (n.length >= 5 ? 5 : 0);
    else {
      // partial: share prefix of 3+
      for (let i = Math.min(n.length, 5); i >= 3; i--) {
        if (h.includes(n.slice(0, i))) {
          score += i;
          break;
        }
      }
    }
  }
  return score;
}

export const GET = withAuthz(async (req: Request) => {
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId");
  const proyectoId = url.searchParams.get("proyectoId");
  const q = (url.searchParams.get("q") ?? "").trim();

  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "CONSTRUCCION");

  if (q.length < 2) {
    return NextResponse.json({ insumos: [], partidas: [] });
  }
  const tokens = tokenize(q);
  if (tokens.length === 0) {
    return NextResponse.json({ insumos: [], partidas: [] });
  }

  // ── Insumos (master) ──────────────────────────────────────────────────
  // Load all the company's insumos + sum of gasto importes per insumo so we
  // can include "gastado" in the suggestion context. Small enough to load
  // in-memory.
  const insumosRaw = await prisma.insumo.findMany({
    where: { companyId },
    select: {
      id: true,
      codigo: true,
      descripcion: true,
      unidad: true,
      tipo: true,
      costoActual: true,
    },
  });
  const insumoGastos = await prisma.gasto.groupBy({
    by: ["insumoId"],
    where: { companyId, insumoId: { not: null }, estado: { in: ["APROBADO", "PAGADO"] } },
    _sum: { importe: true },
  });
  const gastadoByInsumoId = new Map<string, number>();
  for (const g of insumoGastos) {
    if (g.insumoId) gastadoByInsumoId.set(g.insumoId, Number(g._sum.importe ?? 0));
  }

  const insumoScored = insumosRaw
    .map((i) => ({
      ...i,
      _score:
        scoreMatch(i.codigo, tokens) * 2 + // code match is stronger
        scoreMatch(i.descripcion, tokens),
      gastado: gastadoByInsumoId.get(i.id) ?? 0,
    }))
    .filter((i) => i._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 8);

  // ── Partidas (budget leaves, scoped to proyecto if given) ─────────────
  let partidaScored: Array<{
    id: string;
    codigo: string | null;
    cantidad: number | null;
    importe: number;
    concepto: { codigo: string; descripcion: string; unidad: string } | null;
    gastado: number;
    queda: number;
    _score: number;
  }> = [];

  if (proyectoId) {
    const partidasRaw = await prisma.presupuestoPartida.findMany({
      where: {
        esRollup: false,
        presupuesto: {
          companyId,
          proyectoId,
          estado: { in: ["APROBADO", "EN_EJECUCION", "BORRADOR"] },
        },
      },
      select: {
        id: true,
        codigo: true,
        cantidad: true,
        importe: true,
        concepto: { select: { codigo: true, descripcion: true, unidad: true } },
      },
      take: 2000,
    });

    const partidaGastos = await prisma.gasto.groupBy({
      by: ["presupuestoPartidaId"],
      where: {
        companyId,
        proyectoId,
        presupuestoPartidaId: { not: null },
        estado: { in: ["APROBADO", "PAGADO"] },
      },
      _sum: { importe: true },
    });
    const gastadoByPartidaId = new Map<string, number>();
    for (const g of partidaGastos) {
      if (g.presupuestoPartidaId)
        gastadoByPartidaId.set(g.presupuestoPartidaId, Number(g._sum.importe ?? 0));
    }

    partidaScored = partidasRaw
      .map((p) => {
        const concepto = p.concepto;
        const score =
          (concepto ? scoreMatch(concepto.codigo, tokens) * 2 : 0) +
          (concepto ? scoreMatch(concepto.descripcion, tokens) : 0) +
          scoreMatch(p.codigo ?? "", tokens);
        const gastado = gastadoByPartidaId.get(p.id) ?? 0;
        return {
          id: p.id,
          codigo: p.codigo,
          cantidad: p.cantidad === null ? null : Number(p.cantidad),
          importe: Number(p.importe),
          concepto,
          gastado,
          queda: Math.max(0, Number(p.importe) - gastado),
          _score: score,
        };
      })
      .filter((p) => p._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 8);
  }

  return NextResponse.json({
    insumos: insumoScored,
    partidas: partidaScored,
  });
});
