/**
 * Cron: pre-game booking reminders.
 *
 * Finds confirmed reservations starting in the next ~60–75 minutes that haven't
 * been reminded yet, and sends a "sistema" push to the club's staff (members
 * don't have push subscriptions yet — that lands with the member PWA in a later
 * milestone). recordatorioEnviadoAt is stamped so each reservation is reminded
 * once regardless of cron cadence.
 *
 * Auth: shared CRON_SECRET (Bearer or x-cron-secret). Schedule ~every 15 min.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendPushToCompany } from "@/lib/push";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

const LEAD_MIN = 75; // remind up to 75 min before start

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const now = Date.now();
  const horizon = new Date(now + LEAD_MIN * 60_000);

  const due = await prisma.reservation.findMany({
    where: {
      estado: "CONFIRMADA",
      recordatorioEnviadoAt: null,
      inicio: { gt: new Date(now), lte: horizon },
    },
    select: {
      id: true,
      companyId: true,
      inicio: true,
      court: { select: { nombre: true } },
      clubMember: { select: { nombre: true } },
    },
  });

  let pushes = 0;
  for (const r of due) {
    const hora = r.inicio.toISOString().slice(11, 16);
    const quien = r.clubMember?.nombre ? ` — ${r.clubMember.nombre}` : "";
    const res = await sendPushToCompany(
      r.companyId,
      {
        title: "Reserva próxima",
        body: `${r.court.nombre} a las ${hora}${quien}`,
        url: "/padel/reservaciones",
      },
      "sistema"
    );
    pushes += res.sent;
    await prisma.reservation.update({
      where: { id: r.id },
      data: { recordatorioEnviadoAt: new Date() },
    });
  }

  return NextResponse.json({ ok: true, recordatorios: due.length, pushes });
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
