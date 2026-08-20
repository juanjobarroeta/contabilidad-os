import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { intakeEnabled } from "@/lib/intake/config";
import { runTranscribePending } from "@/lib/intake/transcribe";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/intake-transcribe
//
// Transcribe grabaciones de Zoom pendientes (RawIntake → IntakeTranscript).
// Gap-driven: sin grabaciones nuevas es un no-op barato. Reporta `pendientes`
// para el ritmo adaptativo del scheduler.
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
  return withCronLock("intake-transcribe", async () => {
    try {
      const r = await runTranscribePending();
      return NextResponse.json({ ok: true, procesadas: r.transcribed, fallidas: r.failed, pendientes: r.pending });
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
