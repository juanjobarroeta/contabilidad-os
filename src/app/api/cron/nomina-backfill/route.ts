import { NextResponse } from "next/server";
import { backfillNominaRegimen } from "@/lib/nomina/backfill-regimen";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/nomina-backfill
//
// Rellena los datos del complemento de nómina (regimenNomina, tipoNomina,
// isrRetenidoNomina) de los CFDIs tipo NOMINA ya importados, re-parseando el
// rawXml guardado. La lógica vive en lib/nomina/backfill-regimen (compartida con
// el sync del SAT, que la corre automáticamente al terminar). Este endpoint la
// expone para un disparo manual/cron. Soporta ?companyId= para acotar.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
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

  const result = await backfillNominaRegimen(companyId);

  const summary = { ok: true, ...result, elapsedMs: Date.now() - startedAt };
  console.log("[cron/nomina-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
