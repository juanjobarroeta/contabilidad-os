import { NextResponse } from "next/server";
import { runWhatsappCarteraDigest } from "@/lib/whatsapp/digest";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/whatsapp-digest
//
// Resumen diario de la cartera por WhatsApp: para cada link VERIFICADO con la
// preferencia `digestOptIn` activa, envía un mensaje matutino con el estado de
// sus empresas (hallazgos abiertos). No usa LLM (costo ~0). Pensado para correr
// entre semana por la mañana, después del fiscal-audit diario.
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
  try {
    return NextResponse.json({ ok: true, ...(await runWhatsappCarteraDigest()) });
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
