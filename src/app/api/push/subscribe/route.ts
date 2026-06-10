import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// POST /api/push/subscribe — store (or refresh) a Web Push subscription for the
// logged-in user. Body: the browser PushSubscription JSON { endpoint, keys }.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const endpoint: string | undefined = body?.endpoint;
  const p256dh: string | undefined = body?.keys?.p256dh;
  const auth_: string | undefined = body?.keys?.auth;
  const companyId: string | null = body?.companyId ?? null;

  if (!endpoint || !p256dh || !auth_) {
    return NextResponse.json({ error: "Suscripción inválida" }, { status: 400 });
  }

  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { endpoint, p256dh, auth: auth_, userId: session.user.id, companyId },
    update: { p256dh, auth: auth_, userId: session.user.id, companyId },
  });

  return NextResponse.json({ ok: true });
}

// DELETE /api/push/subscribe?endpoint=... — remove a subscription (opt-out).
export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const endpoint = new URL(req.url).searchParams.get("endpoint");
  if (endpoint) await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: session.user.id } });
  return NextResponse.json({ ok: true });
}
