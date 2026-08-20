import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { intakeEnabled } from "@/lib/intake/config";
import { runExtractPending } from "@/lib/intake/extract";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/intake-extract
//
// Agente de extracción: ventanas de WhatsApp cerradas + transcripciones de
// Zoom sin extraer → CandidateAsk (con dedupe por título y por embeddings).
// Cuesta dinero por corrida (Claude) — el scheduler lo lleva con piso MIN_CARO.
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
  return withCronLock("intake-extract", async () => {
    try {
      const r = await runExtractPending();
      return NextResponse.json({
        ok: true,
        ventanas: r.batches,
        transcripciones: r.transcripts,
        nuevos: r.asksCreated,
        pendientes: r.pending,
      });
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
