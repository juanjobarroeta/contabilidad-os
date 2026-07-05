import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import {
  backfillAllDeclaracionesMensuales,
  backfillDeclaracionesMensuales,
} from "@/lib/fiscal/cumplimiento/syntage/declaraciones-backfill";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/declaraciones-backfill   [?companyId=<id>]
//
// Rellena las declaraciones MENSUALES faltantes: descarga el acuse PDF de cada
// tax-return mensual de Syntage y lo parsea con Claude para el desglose IVA/ISR
// (que el recurso estructurado no trae). COSTOSO (1 llamada a Claude por mes sin
// capturar) — por eso es un job aparte, no el sync diario. Gap-fill + resumible:
// re-correr continúa donde quedó. Auth: CRON_SECRET.
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
  const sp = new URL(req.url).searchParams;
  const only = sp.get("companyId");
  // Chunk acotado por corrida (evita timeouts): default 10 acuses. ?max=0 = sin tope.
  const maxParam = parseInt(sp.get("max") ?? "10");
  const maxAcuses = Number.isFinite(maxParam) && maxParam > 0 ? maxParam : undefined;
  try {
    if (only) {
      return NextResponse.json({ ok: true, ...(await backfillDeclaracionesMensuales(only, undefined, { maxAcuses })) });
    }
    return NextResponse.json({ ok: true, ...(await backfillAllDeclaracionesMensuales({ maxAcuses })) });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

export async function POST(req: Request) {
  return withCronLock("cron:declaraciones-backfill", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:declaraciones-backfill", () => handle(req));
}
