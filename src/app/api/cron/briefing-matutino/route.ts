import { NextResponse } from "next/server";
import { enviarBriefingTodos } from "@/lib/briefing/matutino";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/briefing-matutino
//
// El "narrador" del contador AI: un push priorizado por usuario con lo que
// importa hoy (vencimientos próximos, hallazgos críticos, pendientes) + un
// recordatorio SEPARADO para subir el estado de cuenta. No usa LLM (costo ~0).
// Pensado para correr entre semana por la mañana, después del fiscal-audit.
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
  try {
    return NextResponse.json({ ok: true, ...(await enviarBriefingTodos()) });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
