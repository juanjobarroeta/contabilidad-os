import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withCronLock } from "@/lib/cron-lock";
import { syncManagedSession } from "@/lib/contabot/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const matches = (provided: string | null, expected: string) => {
    const left = Buffer.from(provided ?? ""), right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  };
  // The in-process scheduler uses x-cron-secret; external runners use Bearer.
  if (!secret || !(matches(req.headers.get("authorization"), `Bearer ${secret}`) ||
    matches(req.headers.get("x-cron-secret"), secret))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.OPENAI_API_KEY || !process.env.CONTABOT_OPENAI_WEBHOOK_SECRET) {
    return NextResponse.json({ skipped: "managed agent not configured" });
  }
  return withCronLock("contabot-recovery", async () => {
    const sessions = await prisma.contaBotSession.findMany({
      where: { state: { notIn: ["idle", "deleting"] } },
      orderBy: { lastSyncedAt: { sort: "asc", nulls: "first" } }, take: 5, select: { id: true },
    });
    let processed = 0;
    const deadline = Date.now() + 200_000;
    for (const session of sessions) {
      if (Date.now() >= deadline) break;
      try { if (await syncManagedSession(session.id)) processed++; }
      catch { console.error("[contabot] Recovery pass deferred for a session"); }
    }
    return NextResponse.json({ processed, pending: sessions.length });
  });
}

export const GET = POST;
