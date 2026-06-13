import { NextResponse } from "next/server";
import { cotejarInpc } from "@/lib/fiscal/cotejo";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/cotejo-fiscal
//
// Coteja los datos fiscales versionados contra su fuente oficial. Por ahora:
// INPC vs Banxico SIE (serie SP1). Marca el dataset verificado cuando los valores
// cargados empatan, lo que sube "sin cotejar" → "al día" en la cobertura. Sin
// BANXICO_TOKEN se omite (no rompe nada).
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 120;

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
  if (!process.env.BANXICO_TOKEN) {
    return NextResponse.json({ ok: true, skipped: "BANXICO_TOKEN no configurado" });
  }

  const inpc = await cotejarInpc();
  const summary = { ok: inpc.ok, inpc };
  console.log("[cron/cotejo-fiscal] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
