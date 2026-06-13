import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notifyDeclaracionesFaltantes } from "@/lib/notify-declaraciones";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/declaraciones-nag
//
// Recordatorio AGREGADO de acuses de declaración faltantes: un solo push por
// usuario suscrito (= por despacho, en la práctica; el operador recibe uno con
// todas sus empresas). Pensado para correr entre semana mientras falten datos.
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

  // Sólo usuarios que se suscribieron a push (no tiene sentido calcular para
  // quien no recibirá nada).
  const subs = await prisma.pushSubscription.findMany({
    select: { userId: true },
    distinct: ["userId"],
  });

  let usuariosNotificados = 0;
  let pushesEnviados = 0;
  for (const { userId } of subs) {
    try {
      const r = await notifyDeclaracionesFaltantes(userId);
      if (r.total > 0) {
        usuariosNotificados++;
        pushesEnviados += r.notified;
      }
    } catch (e) {
      console.error(`[cron/declaraciones-nag] user ${userId} failed:`, e);
    }
  }

  const summary = { ok: true, usuariosConsiderados: subs.length, usuariosNotificados, pushesEnviados };
  console.log("[cron/declaraciones-nag] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
