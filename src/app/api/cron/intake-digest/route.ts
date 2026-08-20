import { NextResponse } from "next/server";
import { intakeEnabled } from "@/lib/intake/config";
import { runDigest } from "@/lib/intake/telegram";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/intake-digest
//
// Digest de aprobación por Telegram: manda las tarjetas de los asks PENDING
// aún no notificados. Se auto-gatea a las ventanas 08:00 y 18:00 (hora MX);
// el scheduler puede llamarlo seguido sin costo. `?force=1` salta la ventana
// (útil para probar). Idempotente vía notifiedAt.
//
// Auth: CRON_SECRET (Authorization: Bearer <secret> o x-cron-secret: <secret>).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 120;

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
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    return NextResponse.json({ ok: true, ...(await runDigest({ force })) });
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
