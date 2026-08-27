/**
 * CFDI match suggestions — links a CFDI (Invoice) to the operational doc it
 * belongs to, reusing the same ±amount / ±date heuristics as the bank-tx
 * matcher.
 *
 *   RECIBIDA (supplier bill) → requisición (SolicitudCompra) or gasto.
 *   EMITIDA  (client invoice) → estimación.
 *
 * Pools are loaded once per request (batched) so the list endpoint can score
 * every CFDI in-memory instead of querying per row.
 */

import { prisma } from "@/lib/prisma";

const DELTA_PCT = 0.15; // amount tolerance
const WINDOW_DAYS = 20; // date window around the CFDI fecha

export type CfdiCandidate = {
  tipo: "SOLICITUD" | "GASTO" | "ESTIMACION";
  targetId: string;
  label: string;
  monto: number;
  fecha: string | null;
  score: number;
};

export type MatchPools = {
  solicitudes: { id: string; folio: string; total: number; fecha: Date; supplierId: string | null; codigo: string | null }[];
  gastos: { id: string; beneficiario: string; descripcion: string; importe: number; fecha: Date; codigo: string | null }[];
  estimaciones: { id: string; numero: number; total: number; fecha: Date; codigo: string | null }[];
};

export type CfdiForMatch = {
  total: number;
  fecha: Date;
  recibida: boolean;
  emisorNombre: string | null;
  supplierId: string | null;
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

// 1 when amounts are equal, decaying to 0 at the ±tolerance edge and beyond.
function amountScore(a: number, b: number): number {
  if (!a || !b) return 0;
  const rel = Math.abs(a - b) / Math.max(a, b);
  return clamp01(1 - rel / DELTA_PCT);
}

function withinWindow(a: Date, b: Date): boolean {
  const diff = Math.abs(a.getTime() - b.getTime()) / 86_400_000;
  return diff <= WINDOW_DAYS;
}

// Loose token overlap between two names (emisor vs gasto beneficiario).
function nameScore(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const norm = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ");
  const ta = new Set(norm(a).split(/\s+/).filter((t) => t.length > 2));
  const tb = new Set(norm(b).split(/\s+/).filter((t) => t.length > 2));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hits = 0;
  for (const t of ta) if (tb.has(t)) hits++;
  return hits / Math.min(ta.size, tb.size);
}

export async function loadMatchPools(companyId: string): Promise<MatchPools> {
  const [solicitudes, gastos, estimaciones] = await Promise.all([
    prisma.solicitudCompra.findMany({
      where: { companyId, estado: { in: ["APROBADA", "PAGADA"] } },
      select: { id: true, folio: true, total: true, createdAt: true, supplierId: true, proyecto: { select: { codigo: true } } },
      orderBy: { createdAt: "desc" },
      take: 400,
    }),
    prisma.gasto.findMany({
      where: { companyId },
      select: { id: true, beneficiarioNombre: true, descripcion: true, importe: true, createdAt: true, proyecto: { select: { codigo: true } } },
      orderBy: { createdAt: "desc" },
      take: 400,
    }),
    // Estimaciones not yet tied to a CFDI are the live targets for emitidas.
    prisma.estimacion.findMany({
      where: { companyId, invoiceId: null },
      select: { id: true, numero: true, total: true, fechaCorte: true, periodoFin: true, proyecto: { select: { codigo: true } } },
      orderBy: { createdAt: "desc" },
      take: 400,
    }),
  ]);

  return {
    solicitudes: solicitudes.map((s) => ({
      id: s.id, folio: s.folio, total: Number(s.total), fecha: s.createdAt, supplierId: s.supplierId, codigo: s.proyecto?.codigo ?? null,
    })),
    gastos: gastos.map((g) => ({
      id: g.id, beneficiario: g.beneficiarioNombre, descripcion: g.descripcion, importe: Number(g.importe), fecha: g.createdAt, codigo: g.proyecto?.codigo ?? null,
    })),
    estimaciones: estimaciones.map((e) => ({
      id: e.id, numero: e.numero, total: Number(e.total), fecha: e.fechaCorte ?? e.periodoFin, codigo: e.proyecto?.codigo ?? null,
    })),
  };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function rankCandidates(cfdi: CfdiForMatch, pools: MatchPools): CfdiCandidate[] {
  const out: CfdiCandidate[] = [];

  if (cfdi.recibida) {
    for (const sol of pools.solicitudes) {
      const amt = amountScore(cfdi.total, sol.total);
      const supplierMatch = !!cfdi.supplierId && sol.supplierId === cfdi.supplierId;
      if (amt <= 0 && !supplierMatch) continue;
      let score = amt * 0.7;
      if (supplierMatch) score += 0.3;
      if (withinWindow(cfdi.fecha, sol.fecha)) score += 0.05;
      score = clamp01(score);
      if (score < 0.2) continue;
      out.push({ tipo: "SOLICITUD", targetId: sol.id, label: `${sol.folio}${sol.codigo ? ` · ${sol.codigo}` : ""}`, monto: sol.total, fecha: iso(sol.fecha), score });
    }
    for (const g of pools.gastos) {
      const amt = amountScore(cfdi.total, g.importe);
      const nm = nameScore(cfdi.emisorNombre, g.beneficiario);
      if (amt <= 0 && nm <= 0) continue;
      let score = amt * 0.6 + nm * 0.3;
      if (withinWindow(cfdi.fecha, g.fecha)) score += 0.05;
      score = clamp01(score);
      if (score < 0.2) continue;
      const label = g.descripcion ? `${g.beneficiario} · ${g.descripcion}`.slice(0, 50) : g.beneficiario;
      out.push({ tipo: "GASTO", targetId: g.id, label, monto: g.importe, fecha: iso(g.fecha), score });
    }
  } else {
    for (const e of pools.estimaciones) {
      const amt = amountScore(cfdi.total, e.total);
      if (amt <= 0) continue;
      let score = amt * 0.85;
      if (withinWindow(cfdi.fecha, e.fecha)) score += 0.1;
      score = clamp01(score);
      if (score < 0.2) continue;
      out.push({ tipo: "ESTIMACION", targetId: e.id, label: `EST. ${e.numero}${e.codigo ? ` · ${e.codigo}` : ""}`, monto: e.total, fecha: iso(e.fecha), score });
    }
  }

  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}

export function bestSuggestion(cfdi: CfdiForMatch, pools: MatchPools): CfdiCandidate | null {
  return rankCandidates(cfdi, pools)[0] ?? null;
}
