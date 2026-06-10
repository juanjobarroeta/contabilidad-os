import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { sendPushToUser } from "@/lib/push";

// POST /api/push/test — send a test notification to the current user's devices.
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await sendPushToUser(session.user.id, {
    title: "ContabilidadOS",
    body: "Notificaciones activadas ✓ — aquí verás tus facturas emitidas y recibidas.",
    url: "/facturas",
  });

  if (!result.configured) {
    return NextResponse.json({ error: "Push no configurado (faltan VAPID keys en el servidor)" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, sent: result.sent });
}
