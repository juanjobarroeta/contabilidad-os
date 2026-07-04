import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notifyDeclaracionesFaltantes } from "@/lib/notify-declaraciones";
import { notifyImssPago } from "@/lib/notify-imss";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/declaraciones-nag
//
// Recordatorio AGREGADO de acuses de declaración faltantes: un solo push por
// usuario suscrito (= por despacho, en la práctica; el operador recibe uno con
// todas sus empresas). Pensado para correr entre semana mientras falten datos.
//
// Incluye además el recordatorio de pago de cuotas IMSS (SIPARE): desde T-5
// antes del día 17 y por empresa con nómina timbrada sin pago registrado, con
// dedupe fechado `imss-pago:<companyId>:<periodo>:<fecha>` (ver notify-imss).
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

  const hoy = new Date();
  let usuariosNotificados = 0;
  let pushesEnviados = 0;
  let imssEmpresas = 0;
  let imssPushes = 0;
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
    try {
      // Cuotas IMSS (SIPARE) debidas: dedupe fechado por empresa dentro de
      // notify-imss — seguro de re-correr varias veces al día.
      const imss = await notifyImssPago(userId, hoy);
      imssEmpresas += imss.empresas;
      imssPushes += imss.notified;
    } catch (e) {
      console.error(`[cron/declaraciones-nag] imss user ${userId} failed:`, e);
    }
  }

  const summary = {
    ok: true,
    usuariosConsiderados: subs.length,
    usuariosNotificados,
    pushesEnviados,
    imssEmpresas,
    imssPushes,
  };
  console.log("[cron/declaraciones-nag] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
