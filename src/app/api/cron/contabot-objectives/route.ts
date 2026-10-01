import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { runObjectivePass } from "@/lib/contabot/objectives/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const matches = (value: string | null, expected: string) => {
    const a = Buffer.from(value ?? ""), b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  if (!secret || !(matches(req.headers.get("x-cron-secret"), secret) || matches(req.headers.get("authorization"), `Bearer ${secret}`))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.OPENAI_API_KEY || !process.env.CONTABOT_OPENAI_WEBHOOK_SECRET) {
    return NextResponse.json({ skipped: "managed agent not configured" });
  }
  return withCronLock("contabot-objectives", async () => NextResponse.json(await runObjectivePass()));
}
export const GET = POST;
