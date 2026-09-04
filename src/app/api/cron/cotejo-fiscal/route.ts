import { NextResponse } from "next/server";
import { cotejarTodo } from "@/lib/fiscal/cotejo";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/cotejo-fiscal
//
// Coteja los datos fiscales versionados contra su fuente oficial y marca cada
// dataset verificado cuando empata (sube "sin cotejar" → "al día" en la
// cobertura). INPC vs Banxico (requiere BANXICO_TOKEN; sin él se omite),
// multas vs Anexo 5, tarifas vs Anexo 8, recargos vs LIF, UMA vs INEGI
// (requiere INEGI_TOKEN). `?ejercicio=2027` fuerza el ejercicio a cotejar.
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
  return req.headers.get("x-cron-secret") === secret;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const ejParam = new URL(req.url).searchParams.get("ejercicio");
  const ejercicio = ejParam && /^\d{4}$/.test(ejParam) ? Number(ejParam) : undefined;

  const r = await cotejarTodo(ejercicio);
  const ok = !("error" in r.inpc && r.inpc.error) && r.anuales.every((a) => a.ok);
  const summary = { ok, ...r };
  console.log("[cron/cotejo-fiscal] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
