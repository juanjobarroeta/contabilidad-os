import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notifyProyeccionDeclaracion } from "@/lib/notify-proyeccion-declaracion";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/proyeccion-declaracion
//
// Nudge PROACTIVO de proyección de la declaración mensual: en las marcas T-7 y
// T-3 antes del día 17, empuja a cada usuario suscrito las cifras estimadas
// (IVA/ISR) del periodo en juego, con deep-link a los papeles para revisar y
// aprobar. Un push agregado por usuario (la empresa más urgente + conteo del
// resto). La presentación ante el SAT sigue siendo MANUAL.
//
// Pensado para correr en mañanas entre semana; cada empresa sólo dispara en sus
// marcas exactas, así que la mayoría de las corridas no envían nada.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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

  // Sólo usuarios con push activo (no tiene sentido calcular para quien no
  // recibirá nada).
  const subs = await prisma.pushSubscription.findMany({
    select: { userId: true },
    distinct: ["userId"],
  });

  let usuariosNotificados = 0;
  let pushesEnviados = 0;
  for (const { userId } of subs) {
    try {
      const r = await notifyProyeccionDeclaracion(userId);
      if (r.empresasEnMarca > 0 && r.notified > 0) {
        usuariosNotificados++;
        pushesEnviados += r.notified;
      }
    } catch (e) {
      console.error(`[cron/proyeccion-declaracion] user ${userId} failed:`, e);
    }
  }

  const summary = {
    ok: true,
    usuariosConsiderados: subs.length,
    usuariosNotificados,
    pushesEnviados,
  };
  console.log("[cron/proyeccion-declaracion] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
