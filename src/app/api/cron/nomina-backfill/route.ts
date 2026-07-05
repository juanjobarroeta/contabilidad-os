import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { backfillNominaRegimen } from "@/lib/nomina/backfill-regimen";
import {
  importarNominaHistorica,
  importarNominaHistoricaTodas,
} from "@/lib/nomina/historia-import";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/nomina-backfill
//
// Dos pasos idempotentes sobre los CFDIs tipo NOMINA ya importados:
//   1. Rellena los datos del complemento (regimenNomina, tipoNomina,
//      isrRetenidoNomina) re-parseando el rawXml guardado (backfill-regimen,
//      compartido con el sync del SAT que lo corre al terminar).
//   2. Importa el HISTÓRICO de nómina: agrupa los recibos timbrados aún no
//      vinculados a un PayrollRun en corridas por periodo (origen "SAT",
//      sólo lectura). Dedup por folio fiscal — re-ejecutar nunca duplica.
//
// Soporta ?companyId= para acotar a una empresa. Auth: CRON_SECRET (Bearer o
// x-cron-secret), igual que los otros crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId") ?? undefined;
  const startedAt = Date.now();

  const regimen = await backfillNominaRegimen(companyId, { timeBudgetMs: 120_000 });
  const historia = companyId
    ? await importarNominaHistorica(companyId)
    : await importarNominaHistoricaTodas({ timeBudgetMs: 120_000 });

  const summary = { ok: true, regimen, historia, elapsedMs: Date.now() - startedAt };
  console.log("[cron/nomina-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:nomina-backfill", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:nomina-backfill", () => handle(req));
}
