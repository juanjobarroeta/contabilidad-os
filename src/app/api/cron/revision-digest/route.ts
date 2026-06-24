import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notifyHallazgosDigest } from "@/lib/notify-hallazgos";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/revision-digest
//
// Digest matutino del auditor: un solo push por usuario suscrito con el resumen
// de hallazgos ABIERTOS en sus empresas (Revisión). Pensado para correr en la
// mañana entre semana, después del fiscal-audit diario.
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

  const subs = await prisma.pushSubscription.findMany({
    select: { userId: true },
    distinct: ["userId"],
  });

  let usuariosNotificados = 0;
  let pushesEnviados = 0;
  for (const { userId } of subs) {
    try {
      const r = await notifyHallazgosDigest(userId);
      if (r.total > 0 && r.notified > 0) {
        usuariosNotificados++;
        pushesEnviados += r.notified;
      }
    } catch (e) {
      console.error(`[cron/revision-digest] user ${userId} failed:`, e);
    }
  }

  const summary = { ok: true, usuariosConsiderados: subs.length, usuariosNotificados, pushesEnviados };
  console.log("[cron/revision-digest] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
