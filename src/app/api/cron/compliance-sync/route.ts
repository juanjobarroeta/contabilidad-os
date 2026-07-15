import { NextResponse } from "next/server";
import {
  syncAllCompaniesComplianceSyntage,
  syncCompanyComplianceSyntage,
} from "@/lib/fiscal/cumplimiento/syntage/sync";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/compliance-sync   [?companyId=<id>[&reparseAnuales=1]]
//
// Lee los últimos resultados de cumplimiento (opinión SAT + CSF) ya extraídos en
// Syntage y los persiste (ComplianceSnapshot + FiscalHallazgo). Solo GETs a
// Syntage → rápido. La extracción/frescura la dan los schedulers de Syntage.
//
// `reparseAnuales=1` (sólo con companyId) fuerza re-parsear con Claude el acuse
// PDF de todas las anuales de esa empresa, aunque ya tengan datos — corrige
// filas con extracciones parciales/erróneas de parseos viejos (p. ej. pérdida
// pendiente en null con el remanente sí presente en el acuse). Se ignora en la
// corrida global para no disparar una llamada a Claude por cada anual de cada
// empresa.
// Auth: CRON_SECRET.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const only = params.get("companyId");
  const reparseAnuales = params.get("reparseAnuales") === "1";
  try {
    if (only) {
      return NextResponse.json({
        ok: true,
        ...(await syncCompanyComplianceSyntage(only, undefined, { reparseAnuales })),
      });
    }
    return NextResponse.json({ ok: true, ...(await syncAllCompaniesComplianceSyntage()) });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
