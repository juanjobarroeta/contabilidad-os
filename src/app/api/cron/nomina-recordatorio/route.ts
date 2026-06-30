import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notifyNominaRecordatorio } from "@/lib/notify-nomina";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/nomina-recordatorio
//
// Recordatorio proactivo T-1 de nómina: el día ANTES de que toque pagar/timbrar
// (semanal → jueves; quincenal → 14 y víspera de fin de mes; mensual → víspera),
// un solo push por usuario suscrito que resume sus empresas con nómina debida.
// NO dispara timbrado: el timbrado es una acción HUMANA de un toque. Esto sólo
// recuerda y deep-linkea al flujo (/nomina/detalle).
//
// Pensado para correr cada mañana entre semana. La lógica T-1 decide si toca
// hoy según la cadencia de cada empresa, así que es seguro correrlo a diario.
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

  // Sólo usuarios suscritos a push (no tiene sentido calcular para quien no
  // recibirá nada).
  const subs = await prisma.pushSubscription.findMany({
    select: { userId: true },
    distinct: ["userId"],
  });

  const hoy = new Date();
  let usuariosNotificados = 0;
  let pushesEnviados = 0;
  for (const { userId } of subs) {
    try {
      const r = await notifyNominaRecordatorio(userId, hoy);
      if (r.empresas > 0) {
        usuariosNotificados++;
        pushesEnviados += r.notified;
      }
    } catch (e) {
      console.error(`[cron/nomina-recordatorio] user ${userId} failed:`, e);
    }
  }

  const summary = { ok: true, usuariosConsiderados: subs.length, usuariosNotificados, pushesEnviados };
  console.log("[cron/nomina-recordatorio] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
