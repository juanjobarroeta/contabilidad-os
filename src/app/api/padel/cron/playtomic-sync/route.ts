/**
 * Cron: Playtomic two-way booking sync.
 *
 * For every club with PADEL + Playtomic enabled:
 *   1. IMPORT — pull recent bookings from Playtomic and upsert Reservation rows
 *      (matched to a Court by playtomicResourceId; idempotent on
 *      (companyId, playtomicBookingId)).
 *   2. PUSH — best-effort push of native (APP/STAFF) bookings in the window that
 *      aren't yet in Playtomic; stamps playtomicBookingId on success. Degrades
 *      to no-op when the club's API tier doesn't allow writes.
 *
 * Auth: shared CRON_SECRET (Bearer or x-cron-secret), same as /api/cron/sat-sync.
 * Schedule externally (Railway cron / scheduler) ~hourly — Playtomic rate-limits
 * to ~1 req/min, so the job does a single window per club per run.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listBookings, pushBooking, resolveCreds } from "@/lib/playtomic";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

// Import window: yesterday through 14 days out (covers cancellations + upcoming).
const PAST_DAYS = 1;
const FUTURE_DAYS = 14;

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const configs = await prisma.padelClubConfig.findMany({
    where: { playtomicEnabled: true },
    select: {
      companyId: true,
      playtomicEnabled: true,
      playtomicTenantId: true,
      playtomicApiKey: true,
    },
  });

  const now = Date.now();
  const from = new Date(now - PAST_DAYS * 86400_000);
  const to = new Date(now + FUTURE_DAYS * 86400_000);

  const summary: Array<Record<string, unknown>> = [];

  for (const config of configs) {
    const creds = resolveCreds(config);
    if (!creds) continue;
    const companyId = config.companyId;

    let imported = 0;
    let unmatched = 0;
    let pushed = 0;
    let error: string | null = null;

    try {
      // ── 1. IMPORT ──────────────────────────────────────────────────────
      const courts = await prisma.court.findMany({
        where: { companyId, playtomicResourceId: { not: null } },
        select: { id: true, playtomicResourceId: true },
      });
      const courtByResource = new Map(
        courts.map((c) => [c.playtomicResourceId as string, c.id])
      );

      const bookings = await listBookings(creds, from, to);
      for (const b of bookings) {
        const courtId = courtByResource.get(b.resourceId);
        if (!courtId) {
          unmatched++;
          continue;
        }
        await prisma.reservation.upsert({
          where: {
            companyId_playtomicBookingId: {
              companyId,
              playtomicBookingId: b.id,
            },
          },
          create: {
            companyId,
            courtId,
            inicio: new Date(b.start),
            fin: new Date(b.end),
            estado: b.cancelled ? "CANCELADA" : "CONFIRMADA",
            canal: "PLAYTOMIC",
            playtomicBookingId: b.id,
            precio: b.price ?? 0,
            clienteNombre: b.playerName,
          },
          update: {
            inicio: new Date(b.start),
            fin: new Date(b.end),
            estado: b.cancelled ? "CANCELADA" : undefined,
            courtId,
          },
        });
        imported++;
      }

      // ── 2. PUSH ────────────────────────────────────────────────────────
      const native = await prisma.reservation.findMany({
        where: {
          companyId,
          canal: { in: ["APP", "STAFF"] },
          playtomicBookingId: null,
          estado: { not: "CANCELADA" },
          inicio: { gte: new Date(now), lt: to },
          court: { playtomicResourceId: { not: null } },
        },
        select: {
          id: true,
          inicio: true,
          fin: true,
          precio: true,
          court: { select: { playtomicResourceId: true } },
        },
        take: 50,
      });
      for (const r of native) {
        const resourceId = r.court.playtomicResourceId;
        if (!resourceId) continue;
        const extId = await pushBooking(creds, {
          resourceId,
          start: r.inicio,
          end: r.fin,
          price: Number(r.precio),
        });
        if (extId) {
          await prisma.reservation.update({
            where: { id: r.id },
            data: { playtomicBookingId: extId },
          });
          pushed++;
        }
      }

      await prisma.padelClubConfig.update({
        where: { companyId },
        data: { lastPlaytomicSyncAt: new Date() },
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    summary.push({ companyId, imported, unmatched, pushed, error });
  }

  return NextResponse.json({ ok: true, clubs: summary.length, summary });
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
