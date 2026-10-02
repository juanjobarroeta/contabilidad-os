import { prisma } from "./prisma";
import { mesesCompletos } from "./sat-cobertura";

// ─────────────────────────────────────────────────────────────────────────────
// SAT sync / backfill status — answers "¿ya se descargaron mis CFDIs?".
//
// A period is "complete" when BOTH emitidos and recibidos requests for it are
// FINISHED. We compute the full set of in-range months (back to satBackfillYears,
// clamped by fechaInicioOperaciones) and compare against the FINISHED requests.
// ─────────────────────────────────────────────────────────────────────────────

export interface SatSyncStatus {
  backfillYears: number;
  backfillCompleted: boolean;
  backfillCompletedAt: string | null;
  lastSyncAt: string | null;
  periodos: { total: number; completos: number; pendientes: number };
  rango: { desde: string | null; hasta: string }; // YYYY-MM
  cfdisImportados: number;
  faltantes: string[]; // up to 12 missing periods (YYYY-MM), most recent first
}

/** All in-range {year,month} periods, newest first. */
function inRangePeriods(
  backfillYears: number,
  fechaInicio: Date | null,
  now: Date
): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = [];
  const total = backfillYears * 12;
  for (let i = 0; i < total; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    if (fechaInicio) {
      const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);
      if (monthEnd < fechaInicio) break; // older than the company → stop
    }
    out.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }
  return out;
}

export async function getSatSyncStatus(
  companyId: string,
  now: Date = new Date()
): Promise<SatSyncStatus> {
  const [company, finished, importedAgg] = await Promise.all([
    prisma.company.findUnique({
      where: { id: companyId },
      select: {
        satBackfillYears: true,
        satBackfillCompletedAt: true,
        lastAutoSyncAt: true,
        fechaInicioOperaciones: true,
      },
    }),
    prisma.satSyncRequest.findMany({
      where: { companyId, tipo: { in: ["EMITIDOS", "RECIBIDOS"] } },
      select: { year: true, month: true, tipo: true, status: true, desde: true, hasta: true },
    }),
    prisma.satSyncRequest.aggregate({
      where: { companyId },
      _sum: { imported: true },
    }),
  ]);

  const backfillYears = company?.satBackfillYears ?? 5;
  const periods = inRangePeriods(backfillYears, company?.fechaInicioOperaciones ?? null, now);

  // Which periods have BOTH tipos finished?
  // Meses cerrados: completos cuando la unión de los rangos FINISHED de cada
  // lado cubre el mes. El mes en curso nunca puede cubrirse por rango (se
  // pide «del 1 a ayer»): basta una fila FINISHED por lado.
  const mesesOk = mesesCompletos(finished);
  const enCurso = `${now.getFullYear()}-${now.getMonth() + 1}`;
  const ladosEnCurso = new Set(finished.filter((r) => r.status === "FINISHED" && `${r.year}-${r.month}` === enCurso).map((r) => r.tipo));
  const isComplete = (key: string) => {
    const [y, m] = key.split("-").map(Number);
    const k = `${y}-${m}`;
    if (k === enCurso) return ladosEnCurso.has("EMITIDOS") && ladosEnCurso.has("RECIBIDOS");
    return mesesOk.has(k);
  };

  const keys = periods.map((p) => `${p.year}-${String(p.month).padStart(2, "0")}`);
  const faltantes = keys.filter((k) => !isComplete(k));
  const completos = keys.length - faltantes.length;

  return {
    backfillYears,
    backfillCompleted: company?.satBackfillCompletedAt != null,
    backfillCompletedAt: company?.satBackfillCompletedAt?.toISOString() ?? null,
    lastSyncAt: company?.lastAutoSyncAt?.toISOString() ?? null,
    periodos: { total: keys.length, completos, pendientes: faltantes.length },
    rango: { desde: keys.at(-1) ?? null, hasta: keys[0] ?? "" },
    cfdisImportados: importedAgg._sum.imported ?? 0,
    faltantes: faltantes.slice(0, 12),
  };
}
