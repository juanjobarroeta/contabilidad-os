import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { diaSemanaLocal, horaLocal, intakeEnabled } from "@/lib/intake/config";
import { runWeeklyScoring } from "@/lib/intake/score";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/intake-score
//
// Scoring semanal del tablero (lunes 06:00 MX): recalcula el Score de cada
// issue abierto, guarda snapshot y manda el digest de prioridades a Telegram.
// Se auto-gatea al lunes por la mañana; el snapshot único por semana lo hace
// idempotente aunque el scheduler lo llame cada hora. `?force=1` salta la
// ventana (el snapshot sigue mandando: una corrida por semana).
//
// Auth: CRON_SECRET (Authorization: Bearer <secret> o x-cron-secret: <secret>).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if not configured
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!intakeEnabled()) return NextResponse.json({ ok: true, skipped: "intake disabled" });

  const force = new URL(req.url).searchParams.get("force") === "1";
  // Ventana: lunes 06:00–08:59 MX. Holgada a propósito — el snapshot único
  // por semana evita corridas dobles, y la holgura evita perder la semana si
  // el tick de las 6 cayó justo durante un deploy.
  if (!force && !(diaSemanaLocal() === 1 && horaLocal() >= 6 && horaLocal() < 9)) {
    return NextResponse.json({ ok: true, skipped: "fuera de ventana (lunes 06-09 MX)" });
  }

  return withCronLock("intake-score", async () => {
    try {
      return NextResponse.json({ ok: true, ...(await runWeeklyScoring()) });
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: e instanceof Error ? e.message : String(e) },
        { status: 502 }
      );
    }
  });
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
